import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';

import type {
  ManagedPtyHandleSummary,
  MessagesUpsertPayload,
  RuntimeMetaPayload,
  SelectConversationResultPayload,
  TerminalFramePatchPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { TerminalFrameLine, TerminalFrameSnapshot } from '@lzdi/pty-remote-protocol/terminal-frame.ts';
import type { ChatMessage, ProviderId, RuntimeSnapshot, RuntimeStatus } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import {
  applyCodexJsonlLine,
  createCodexJsonlMessagesState,
  markCodexJsonlTurnInterrupted,
  materializeCodexJsonlMessages,
  type CodexJsonlMessagesState,
  type CodexJsonlRuntimePhase
} from './codex-jsonl.ts';
import {
  appendRecentOutput,
  getCodexPtyLifecycle,
  looksLikeDirectoryTrustPrompt,
  looksLikeInterruptedOutput,
  looksLikeModelChoicePrompt,
  looksLikeUpdatePrompt,
  looksReadyForInput,
  resizeCodexPtySession,
  showsStarterPrompt,
  startCodexPtySession,
  stopCodexPtySession,
  type CodexPtySession
} from './codex-pty.ts';
import { prepareCodexResumeSession } from './codex-resume-session.ts';
import { findCodexSessionFile, findLatestCodexSessionForCwdSince, type CodexHistoryOptions } from './codex-history.ts';
import { HeadlessTerminalFrameState } from '../terminal/frame-state.ts';

export interface CodexManagerOptions extends CodexHistoryOptions {
  defaultCwd: string;
  terminalCols: number;
  terminalRows: number;
  terminalFrameScrollback: number;
  recentOutputMaxChars: number;
  codexReadyTimeoutMs: number;
  promptSubmitDelayMs: number;
  jsonlRefreshDebounceMs: number;
  snapshotMessagesMax: number;
  gcIntervalMs: number;
  detachedDraftTtlMs: number;
  detachedJsonlMissingTtlMs: number;
  detachedPtyTtlMs: number;
  maxDetachedPtys: number;
}

interface CodexManagerCallbacks {
  emitMessagesUpsert(payload: Omit<MessagesUpsertPayload, 'cliId'>): void;
  emitRuntimeMeta(payload: Omit<RuntimeMetaPayload, 'cliId'>): void;
  emitTerminalFramePatch(payload: Omit<TerminalFramePatchPayload, 'cliId' | 'providerId'>): void;
  emitTerminalSessionEvicted(payload: {
    conversationKey: string | null;
    reason: string;
    sessionId: string;
  }): void;
}

export interface CodexManagerSelection {
  cwd: string;
  label: string;
  sessionId: string | null;
  conversationKey: string;
}

interface RuntimeCleanupTarget {
  cwd: string;
  conversationKey: string;
  sessionId: string | null;
}

interface AgentRuntimeState extends RuntimeSnapshot {
  allMessages: ChatMessage[];
  recentTerminalOutput: string;
}

type HandleLifecycle = 'attached' | 'detached' | 'exited' | 'error';

interface CodexHandle {
  threadKey: string;
  cwd: string;
  label: string;
  sessionId: string | null;
  sessionFilePath: string | null;
  pendingNewSessionDiscoveryStartedAt: number | null;
  lifecycle: HandleLifecycle;
  pty: CodexPtySession | null;
  ptyToken: number;
  jsonlWatcher: FSWatcher | null;
  watchedJsonlFilePath: string | null;
  jsonlMessagesState: CodexJsonlMessagesState;
  parsedJsonlSessionId: string | null;
  jsonlReadOffset: number;
  jsonlPendingLine: string;
  awaitingJsonlTurn: boolean;
  suppressNextPtyExitError: boolean;
  expectedPtyExitReason: string | null;
  runtime: AgentRuntimeState;
  terminalFrame: HeadlessTerminalFrameState;
  detachedAt: number | null;
  discoveryStartedAt: number | null;
  jsonlMissingSince: number | null;
  lastJsonlActivityAt: number | null;
  lastTerminalActivityAt: number | null;
  lastUserInputAt: number | null;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function tailForLog(text: string | null | undefined, maxChars = 1200): string {
  if (!text) {
    return '';
  }
  return text.slice(-maxChars);
}

function messageEqual(left: ChatMessage | undefined, right: ChatMessage | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id &&
    left.role === right.role &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.sequence === right.sequence &&
    JSON.stringify(left.meta ?? null) === JSON.stringify(right.meta ?? null) &&
    JSON.stringify(left.blocks) === JSON.stringify(right.blocks)
  );
}

function messagesEqual(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => messageEqual(message, right[index]));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const AWAITING_JSONL_TURN_STALE_MS = 4000;
const NEW_SESSION_DISCOVERY_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MAX_RETRIES = 2;
const TERMINAL_READY_BOTTOM_LINES = 8;
const INTERRUPT_READY_CHECK_DELAY_MS = 250;

function isNewSessionSlashCommand(content: string): boolean {
  const [firstLine = ''] = content.trim().split('\n', 1);
  return firstLine === '/new' || firstLine.startsWith('/new ');
}

function materializeTerminalFrameLinesText(lines: TerminalFrameLine[]): string {
  return lines
    .map((line) => line.runs.map((run) => run.text).join('').replace(/\s+$/u, ''))
    .join('\n');
}

function getVisibleTerminalFrameLines(snapshot: TerminalFrameSnapshot): TerminalFrameLine[] {
  if (snapshot.lines.length === 0 || snapshot.rows <= 0) {
    return [];
  }

  const visibleStartIndex = Math.max(0, snapshot.viewportY - snapshot.tailStart);
  const visibleEndIndex = Math.min(snapshot.lines.length, visibleStartIndex + snapshot.rows);
  return snapshot.lines.slice(visibleStartIndex, visibleEndIndex);
}

function trimTrailingEmptyTerminalLines(lines: TerminalFrameLine[]): TerminalFrameLine[] {
  let endIndex = lines.length;
  while (endIndex > 0) {
    const text = lines[endIndex - 1]?.runs.map((run) => run.text).join('').trim() ?? '';
    if (text.length > 0) {
      break;
    }
    endIndex -= 1;
  }
  return lines.slice(0, endIndex);
}

export class CodexManager {
  private readonly providerId: ProviderId = 'codex';

  private readonly callbacks: CodexManagerCallbacks;

  private readonly handles = new Map<string, CodexHandle>();

  private readonly options: CodexManagerOptions;

  private activeThreadKey: string | null = null;

  private currentCwd: string;

  private jsonlRefreshTimer: NodeJS.Timeout | null = null;

  private jsonlRefreshDueAt: number | null = null;

  private readonly gcTimer: NodeJS.Timeout;

  private terminalSize: { cols: number; rows: number };

  constructor(options: CodexManagerOptions, callbacks: CodexManagerCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
    this.currentCwd = options.defaultCwd;
    this.terminalSize = {
      cols: options.terminalCols,
      rows: options.terminalRows
    };
    this.gcTimer = setInterval(() => {
      void this.gcDetachedHandles();
    }, options.gcIntervalMs);
    this.gcTimer.unref();
  }

  private log(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
    const logger = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    if (details) {
      logger(`[pty-remote][codex] ${message}`, details);
      return;
    }
    logger(`[pty-remote][codex] ${message}`);
  }

  private handleContext(handle: CodexHandle): Record<string, unknown> {
    return {
      conversationKey: handle.threadKey,
      cwd: handle.cwd,
      sessionFilePath: handle.sessionFilePath,
      sessionId: handle.sessionId
    };
  }

  getRegistrationPayload(): {
    conversationKey: string | null;
    cwd: string;
    sessionId: string | null;
  } {
    const handle = this.getActiveHandle();
    return {
      cwd: handle?.cwd ?? this.currentCwd,
      sessionId: handle?.sessionId ?? null,
      conversationKey: handle?.threadKey ?? null
    };
  }

  updateTerminalSize(cols: number, rows: number): void {
    const nextCols = Number.isFinite(cols) ? Math.max(20, Math.min(Math.floor(cols), 400)) : this.terminalSize.cols;
    const nextRows = Number.isFinite(rows) ? Math.max(8, Math.min(Math.floor(rows), 200)) : this.terminalSize.rows;
    this.terminalSize = {
      cols: nextCols,
      rows: nextRows
    };

    const handle = this.getActiveHandle();
    resizeCodexPtySession(handle?.pty ?? null, nextCols, nextRows);
    if (!handle) {
      return;
    }

    const patch = handle.terminalFrame.resize(nextCols, nextRows);
    if (patch && this.isActiveHandle(handle)) {
      this.emitTerminalFramePatch(handle, patch);
    }
  }

  listManagedPtyHandles(): ManagedPtyHandleSummary[] {
    return [...this.handles.values()]
      .map((handle) => {
        const lastActivityAt = this.getLastActivityAt(handle);
        return {
          conversationKey: handle.threadKey,
          sessionId: handle.sessionId,
          cwd: handle.cwd,
          label: handle.label,
          lifecycle: handle.lifecycle,
          hasPty: handle.pty !== null,
          lastActivityAt: lastActivityAt > 0 ? lastActivityAt : null
        };
      })
      .sort((left, right) => {
        if (left.hasPty !== right.hasPty) {
          return left.hasPty ? -1 : 1;
        }
        const leftLastActivityAt = left.lastActivityAt ?? 0;
        const rightLastActivityAt = right.lastActivityAt ?? 0;
        if (leftLastActivityAt !== rightLastActivityAt) {
          return rightLastActivityAt - leftLastActivityAt;
        }
        return left.conversationKey.localeCompare(right.conversationKey);
      });
  }

  async activateConversation(selection: CodexManagerSelection): Promise<SelectConversationResultPayload> {
    const normalized = await this.normalizeSelection(selection);
    const current = this.getActiveHandle();
    if (current && current.threadKey !== normalized.conversationKey) {
      this.detachHandle(current);
    }

    let handle = this.handles.get(normalized.conversationKey);
    if (!handle) {
      handle = this.createHandle(normalized);
      this.handles.set(handle.threadKey, handle);
    } else {
      this.syncHandleSelection(handle, normalized);
    }

    this.activeThreadKey = handle.threadKey;
    this.currentCwd = handle.cwd;
    handle.lifecycle = 'attached';
    handle.detachedAt = null;
    handle.jsonlMissingSince = null;

    if (handle.sessionId && !handle.sessionFilePath) {
      handle.sessionFilePath = await findCodexSessionFile(handle.sessionId, this.options);
    }

    if (!handle.pty) {
      this.clearLastError(handle);
      await this.ensureHandleSession(handle);
    } else {
      this.ensureJsonlWatcher(handle, handle.sessionFilePath);
    }

    await this.refreshMessagesFromJsonl(handle);
    this.emitRuntimeMeta(handle);

    return {
      providerId: this.providerId,
      cwd: handle.cwd,
      label: handle.label,
      sessionId: handle.sessionId,
      conversationKey: handle.threadKey
    };
  }

  async dispatchMessage(content: string): Promise<void> {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new Error('Message cannot be empty');
    }

    const handle = this.getActiveHandle();
    if (!handle) {
      throw new Error('No active thread selected');
    }

    this.clearLastError(handle);
    if (this.isBusyStatus(handle.runtime.status)) {
      throw new Error('Codex is still handling the previous message');
    }

    await this.ensureHandleSession(handle);
    const pendingNewSessionDiscoveryStartedAt = isNewSessionSlashCommand(trimmedContent) ? Date.now() : null;

    try {
      await this.waitForHandleReadyWithRetry(handle);
      handle.pendingNewSessionDiscoveryStartedAt = pendingNewSessionDiscoveryStartedAt;
      handle.awaitingJsonlTurn = true;
      handle.lastUserInputAt = Date.now();
      this.setStatus(handle, 'running');
      await this.sendPromptToHandle(handle, trimmedContent);
      this.scheduleJsonlRefresh(0, 'send-message');
    } catch (error) {
      this.log('error', 'dispatchMessage failed', {
        ...this.handleContext(handle),
        error: errorMessage(error, 'Codex request failed'),
        promptLength: trimmedContent.length
      });
      if (handle.pendingNewSessionDiscoveryStartedAt === pendingNewSessionDiscoveryStartedAt) {
        handle.pendingNewSessionDiscoveryStartedAt = null;
      }
      this.setStatus(handle, 'idle');
      this.setLastError(handle, error instanceof Error ? error.message : 'Codex request failed');
      throw error;
    }
  }

  async stopActiveRun(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle || !this.isBusyStatus(handle.runtime.status)) {
      return;
    }

    this.clearLastError(handle);
    await this.sendInterruptSequence(handle);
    await this.maybeMarkHandleReadyAfterInterrupt(handle);
    this.scheduleJsonlRefresh(0, 'stop-active-run');
  }

  async resetActiveThread(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }

    this.closeJsonlWatcher(handle);
    this.stopHandlePty(handle, 'reset-session');
    handle.sessionId = null;
    handle.sessionFilePath = null;
    this.resetHandleRuntime(handle, null);
    handle.lifecycle = 'attached';
    handle.detachedAt = null;
    handle.discoveryStartedAt = null;
    this.emitRuntimeMeta(handle);
  }

  async sendTerminalInput(input: string): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      throw new Error('No active thread selected');
    }

    if (!input) {
      return;
    }

    await this.ensureHandleSession(handle);
    if (!handle.pty) {
      throw new Error('Codex PTY session is not running');
    }

    handle.lastUserInputAt = Date.now();
    handle.pty.pty.write(input);
  }

  async cleanupProject(cwd: string): Promise<void> {
    const normalizedCwd = await this.normalizeProjectCwd(cwd);
    const targets = [...this.handles.values()].filter((handle) => handle.cwd === normalizedCwd);
    for (const handle of targets) {
      this.destroyHandle(handle, 'cleanup-project');
    }
  }

  async cleanupConversation(target: RuntimeCleanupTarget): Promise<void> {
    const normalizedCwd = await this.normalizeProjectCwd(target.cwd);
    const matches = [...this.handles.values()].filter((handle) => {
      if (handle.cwd !== normalizedCwd) {
        return false;
      }
      return (
        handle.threadKey === target.conversationKey ||
        (target.sessionId !== null && handle.sessionId === target.sessionId)
      );
    });
    for (const handle of matches) {
      this.destroyHandle(handle, 'cleanup-conversation');
    }
  }

  async shutdown(): Promise<void> {
    if (this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
      this.jsonlRefreshTimer = null;
    }
    clearInterval(this.gcTimer);
    for (const handle of this.handles.values()) {
      this.closeJsonlWatcher(handle);
      this.stopHandlePty(handle, 'shutdown');
    }
  }

  private createHandle(selection: CodexManagerSelection): CodexHandle {
    return {
      threadKey: selection.conversationKey,
      cwd: selection.cwd,
      label: selection.label,
      sessionId: selection.sessionId,
      sessionFilePath: null,
      pendingNewSessionDiscoveryStartedAt: null,
      lifecycle: 'exited',
      pty: null,
      ptyToken: 0,
      jsonlWatcher: null,
      watchedJsonlFilePath: null,
      jsonlMessagesState: createCodexJsonlMessagesState(),
      parsedJsonlSessionId: selection.sessionId,
      jsonlReadOffset: 0,
      jsonlPendingLine: '',
      awaitingJsonlTurn: false,
      suppressNextPtyExitError: false,
      expectedPtyExitReason: null,
      runtime: this.createFreshState(selection.conversationKey, selection.sessionId),
      terminalFrame: new HeadlessTerminalFrameState({
        cols: this.terminalSize.cols,
        maxLines: this.options.terminalFrameScrollback,
        rows: this.terminalSize.rows,
        scrollback: this.options.terminalFrameScrollback
      }),
      detachedAt: null,
      discoveryStartedAt: null,
      jsonlMissingSince: null,
      lastJsonlActivityAt: null,
      lastTerminalActivityAt: null,
      lastUserInputAt: null
    };
  }

  private createFreshState(conversationKey: string | null, sessionId: string | null): AgentRuntimeState {
    return {
      providerId: this.providerId,
      conversationKey,
      status: 'idle',
      sessionId,
      allMessages: [],
      recentTerminalOutput: '',
      messages: [],
      hasOlderMessages: false,
      lastError: null
    };
  }

  private emitRuntimeMeta(handle: CodexHandle): void {
    this.callbacks.emitRuntimeMeta({
      providerId: this.providerId,
      conversationKey: handle.threadKey,
      cwd: handle.cwd,
      lastError: handle.runtime.lastError,
      sessionId: handle.runtime.sessionId,
      status: handle.runtime.status
    } satisfies Omit<RuntimeMetaPayload, 'cliId'>);
  }

  private getActiveHandle(): CodexHandle | null {
    if (!this.activeThreadKey) {
      return null;
    }

    return this.handles.get(this.activeThreadKey) ?? null;
  }

  private isActiveHandle(handle: CodexHandle): boolean {
    return this.activeThreadKey === handle.threadKey;
  }

  private isBusyStatus(status: RuntimeStatus): boolean {
    return status === 'starting' || status === 'running';
  }

  private async normalizeSelection(selection: CodexManagerSelection): Promise<CodexManagerSelection> {
    const cwd = await this.normalizeProjectCwd(selection.cwd);
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      throw new Error('Selected project is not a directory');
    }

    return {
      cwd,
      label: selection.label.trim() || path.basename(cwd) || cwd,
      sessionId: selection.sessionId,
      conversationKey: selection.conversationKey
    };
  }

  private async normalizeProjectCwd(cwd: string): Promise<string> {
    const resolvedCwd = path.resolve(cwd);
    return fs.realpath(resolvedCwd).catch(() => resolvedCwd);
  }

  private syncHandleSelection(handle: CodexHandle, selection: CodexManagerSelection): void {
    handle.cwd = selection.cwd;
    handle.label = selection.label;
    handle.runtime.providerId = this.providerId;
    handle.runtime.conversationKey = selection.conversationKey;

    if (handle.sessionId === null) {
      handle.sessionId = selection.sessionId;
      handle.runtime.sessionId = selection.sessionId;
      return;
    }

    if (!handle.pty && selection.sessionId && handle.sessionId !== selection.sessionId) {
      handle.sessionId = selection.sessionId;
      handle.runtime.sessionId = selection.sessionId;
      handle.sessionFilePath = null;
      handle.discoveryStartedAt = null;
      this.resetJsonlParsingState(handle, selection.sessionId);
    }
  }

  private resetJsonlParsingState(handle: CodexHandle, sessionId: string | null): void {
    handle.jsonlMessagesState = createCodexJsonlMessagesState();
    handle.parsedJsonlSessionId = sessionId;
    handle.jsonlReadOffset = 0;
    handle.jsonlPendingLine = '';
  }

  private resetHandleRuntime(handle: CodexHandle, sessionId: string | null): void {
    handle.runtime = this.createFreshState(handle.threadKey, sessionId);
    handle.sessionId = sessionId;
    handle.pendingNewSessionDiscoveryStartedAt = null;
    handle.awaitingJsonlTurn = false;
    handle.jsonlMissingSince = null;
    handle.lastJsonlActivityAt = null;
    handle.lastTerminalActivityAt = null;
    handle.lastUserInputAt = null;
    this.resetJsonlParsingState(handle, sessionId);
  }

  private closeJsonlWatcher(handle: CodexHandle): void {
    if (!handle.jsonlWatcher) {
      return;
    }

    handle.jsonlWatcher.close();
    handle.jsonlWatcher = null;
    handle.watchedJsonlFilePath = null;
  }

  private ensureJsonlWatcher(handle: CodexHandle, filePath: string | null): void {
    if (!this.isActiveHandle(handle) && !handle.pty) {
      this.closeJsonlWatcher(handle);
      return;
    }

    if (!filePath) {
      this.closeJsonlWatcher(handle);
      return;
    }

    if (handle.jsonlWatcher && handle.watchedJsonlFilePath === filePath) {
      return;
    }

    this.closeJsonlWatcher(handle);

    const dirPath = path.dirname(filePath);
    const fileName = path.basename(filePath);

    try {
      handle.jsonlWatcher = watchFs(dirPath, { persistent: false }, (_eventType, changedFileName) => {
        if ((!this.isActiveHandle(handle) && !handle.pty) || handle.sessionFilePath !== filePath) {
          return;
        }
        if (typeof changedFileName === 'string' && changedFileName.length > 0 && changedFileName !== fileName) {
          return;
        }
        if (this.isActiveHandle(handle)) {
          this.scheduleJsonlRefresh(0, 'jsonl-watcher');
          return;
        }
        void this.refreshMessagesFromJsonl(handle);
      });
      handle.watchedJsonlFilePath = filePath;
      handle.jsonlWatcher.on('error', (error) => {
        if ((!this.isActiveHandle(handle) && !handle.pty) || handle.sessionFilePath !== filePath) {
          return;
        }
        this.closeJsonlWatcher(handle);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return;
        }
        this.log('error', 'jsonl watcher error', {
          ...this.handleContext(handle),
          code,
          dirPath,
          error: errorMessage(error, 'Failed to watch Codex jsonl'),
          filePath
        });
        this.setLastError(handle, error instanceof Error ? error.message : 'Failed to watch Codex jsonl');
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return;
      }
      this.log('error', 'failed to start jsonl watcher', {
        ...this.handleContext(handle),
        code,
        dirPath,
        error: errorMessage(error, 'Failed to watch Codex jsonl'),
        filePath
      });
      this.setLastError(handle, error instanceof Error ? error.message : 'Failed to watch Codex jsonl');
    }
  }

  private resolveRuntimeStatusFromState(handle: CodexHandle, runtimePhase: CodexJsonlRuntimePhase): RuntimeStatus {
    if (handle.runtime.lastError !== null && handle.runtime.status === 'error') {
      return 'error';
    }

    if (runtimePhase === 'running' || handle.awaitingJsonlTurn) {
      return 'running';
    }

    return 'idle';
  }

  private shouldContinueJsonlRefresh(handle: CodexHandle): boolean {
    if (!this.isActiveHandle(handle) || !handle.pty) {
      return false;
    }

    return (
      handle.pendingNewSessionDiscoveryStartedAt !== null ||
      handle.awaitingJsonlTurn ||
      handle.runtime.status === 'starting' ||
      handle.runtime.status === 'running'
    );
  }

  private maybeClearStaleAwaitingTurn(handle: CodexHandle): void {
    if (!handle.awaitingJsonlTurn || !handle.lastUserInputAt) {
      return;
    }

    const elapsedMs = Date.now() - handle.lastUserInputAt;
    if (elapsedMs < AWAITING_JSONL_TURN_STALE_MS) {
      return;
    }

    handle.awaitingJsonlTurn = false;
  }

  private selectRecentMessages(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= this.options.snapshotMessagesMax) {
      return messages;
    }
    return messages.slice(-this.options.snapshotMessagesMax);
  }

  private createMessagesUpsertPayload(
    handle: CodexHandle,
    previousMessages: ChatMessage[],
    nextMessages: ChatMessage[],
    previousHasOlderMessages: boolean,
    hasOlderMessages: boolean
  ): Omit<MessagesUpsertPayload, 'cliId'> | null {
    const previousIds = previousMessages.map((message) => message.id);
    const nextIds = nextMessages.map((message) => message.id);
    const idsChanged =
      previousIds.length !== nextIds.length || previousIds.some((messageId, index) => messageId !== nextIds[index]);
    const olderFlagChanged = previousHasOlderMessages !== hasOlderMessages;

    const previousById = new Map(previousMessages.map((message) => [message.id, message]));
    const upserts = nextMessages.filter((message) => !messageEqual(previousById.get(message.id), message));

    if (!idsChanged && upserts.length === 0 && !olderFlagChanged) {
      return null;
    }

    return {
      providerId: this.providerId,
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      upserts: cloneValue(upserts),
      recentMessageIds: nextIds,
      hasOlderMessages
    };
  }

  private syncHandleRuntimeFromJsonlState(
    handle: CodexHandle,
    previousMessages: ChatMessage[],
    previousHasOlderMessages: boolean
  ): void {
    const nextAllMessages = materializeCodexJsonlMessages(handle.jsonlMessagesState);
    const nextMessages = this.selectRecentMessages(nextAllMessages);
    const nextHasOlderMessages = nextAllMessages.length > nextMessages.length;
    const nextRuntimeStatus = this.resolveRuntimeStatusFromState(handle, handle.jsonlMessagesState.runtimePhase);
    const allMessagesChanged = !messagesEqual(handle.runtime.allMessages, nextAllMessages);
    const messagesChanged = !messagesEqual(handle.runtime.messages, nextMessages);
    const hasOlderMessagesChanged = handle.runtime.hasOlderMessages !== nextHasOlderMessages;
    const statusChanged = handle.runtime.status !== nextRuntimeStatus;

    if (allMessagesChanged) {
      handle.runtime.allMessages = nextAllMessages;
    }
    if (messagesChanged) {
      handle.runtime.messages = nextMessages;
    }
    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
      handle.runtime.hasOlderMessages = nextHasOlderMessages;
    }
    if (statusChanged) {
      handle.runtime.status = nextRuntimeStatus;
      this.emitRuntimeMeta(handle);
    }

    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged || statusChanged) {
      const upsertPayload = this.createMessagesUpsertPayload(
        handle,
        previousMessages,
        nextMessages,
        previousHasOlderMessages,
        nextHasOlderMessages
      );
      if (upsertPayload) {
        this.callbacks.emitMessagesUpsert(upsertPayload);
      }
    }
  }

  private markHandleTurnInterrupted(handle: CodexHandle, source: 'manual-interrupt' | 'terminal-output'): void {
    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;
    const wasBusy =
      handle.awaitingJsonlTurn || handle.runtime.status === 'running' || handle.jsonlMessagesState.runtimePhase === 'running';

    handle.awaitingJsonlTurn = false;
    const stateChanged = markCodexJsonlTurnInterrupted(handle.jsonlMessagesState, handle.jsonlMessagesState.activeTurnId);
    if (!stateChanged && !wasBusy) {
      return;
    }

    this.log('warn', 'marking codex turn interrupted from fallback', {
      ...this.handleContext(handle),
      source,
      runtimeStatus: handle.runtime.status
    });
    this.syncHandleRuntimeFromJsonlState(handle, previousMessages, previousHasOlderMessages);
  }

  private async maybeMarkHandleInterruptedFromTerminal(handle: CodexHandle): Promise<void> {
    if (
      !handle.pty ||
      (!handle.awaitingJsonlTurn && handle.runtime.status !== 'running' && handle.jsonlMessagesState.runtimePhase !== 'running')
    ) {
      return;
    }

    if (!looksLikeInterruptedOutput(handle.runtime.recentTerminalOutput)) {
      return;
    }

    const { bottomText, visibleText } = await this.getHandleTerminalView(handle);
    if (!looksLikeInterruptedOutput(visibleText)) {
      return;
    }

    if (getCodexPtyLifecycle(bottomText) === 'running') {
      return;
    }

    this.markHandleTurnInterrupted(handle, 'terminal-output');
  }

  private async readJsonlTail(filePath: string, startOffset: number): Promise<{ size: number; text: string }> {
    const stat = await fs.stat(filePath);
    if (startOffset >= stat.size) {
      return {
        text: '',
        size: stat.size
      };
    }

    const fileHandle = await fs.open(filePath, 'r');
    try {
      const length = stat.size - startOffset;
      const buffer = Buffer.alloc(length);
      await fileHandle.read(buffer, 0, length, startOffset);
      return {
        text: buffer.toString('utf8'),
        size: stat.size
      };
    } finally {
      await fileHandle.close();
    }
  }

  private async discoverSessionForHandle(handle: CodexHandle): Promise<void> {
    if (handle.sessionId || !handle.discoveryStartedAt) {
      return;
    }

    const match = await findLatestCodexSessionForCwdSince(handle.cwd, handle.discoveryStartedAt, this.options);
    if (!match) {
      return;
    }

    handle.sessionId = match.sessionId;
    handle.runtime.sessionId = match.sessionId;
    handle.sessionFilePath = match.filePath;
    handle.discoveryStartedAt = null;
    this.resetJsonlParsingState(handle, match.sessionId);

    if (this.isActiveHandle(handle) || handle.pty) {
      this.ensureJsonlWatcher(handle, match.filePath);
    }
    this.emitRuntimeMeta(handle);
  }

  private async discoverReplacementSessionForHandle(handle: CodexHandle): Promise<void> {
    const startedAt = handle.pendingNewSessionDiscoveryStartedAt;
    if (!startedAt) {
      return;
    }

    const match = await findLatestCodexSessionForCwdSince(handle.cwd, startedAt, this.options);
    if (!match) {
      if (Date.now() - startedAt >= NEW_SESSION_DISCOVERY_TIMEOUT_MS) {
        this.log('warn', 'timed out waiting for codex /new session discovery', {
          ...this.handleContext(handle),
          waitMs: Date.now() - startedAt
        });
        handle.pendingNewSessionDiscoveryStartedAt = null;
      }
      return;
    }

    if (match.sessionId === handle.sessionId) {
      return;
    }

    handle.pendingNewSessionDiscoveryStartedAt = null;
    handle.sessionId = match.sessionId;
    handle.runtime.sessionId = match.sessionId;
    handle.sessionFilePath = match.filePath;
    handle.discoveryStartedAt = null;
    handle.jsonlMissingSince = null;
    handle.runtime.allMessages = [];
    handle.runtime.messages = [];
    handle.runtime.hasOlderMessages = false;
    handle.runtime.lastError = null;
    this.resetJsonlParsingState(handle, match.sessionId);

    const terminalResetPatch = handle.terminalFrame.reset(match.sessionId);
    this.emitRuntimeMeta(handle);
    if (this.isActiveHandle(handle)) {
      this.emitTerminalFramePatch(handle, terminalResetPatch);
    }
    if (this.isActiveHandle(handle) || handle.pty) {
      this.ensureJsonlWatcher(handle, match.filePath);
    }
  }

  private async refreshMessagesFromJsonl(handle: CodexHandle): Promise<void> {
    await this.discoverSessionForHandle(handle);
    await this.discoverReplacementSessionForHandle(handle);

    const sessionId = handle.sessionId;
    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;
    const previousStatus = handle.runtime.status;
    const previousActivityRevision = handle.jsonlMessagesState.activityRevision;

    if (!sessionId) {
      this.closeJsonlWatcher(handle);
      const nextStatus = this.resolveRuntimeStatusFromState(handle, handle.jsonlMessagesState.runtimePhase);
      if (this.isActiveHandle(handle) && handle.runtime.status !== nextStatus) {
        handle.runtime.status = nextStatus;
        this.emitRuntimeMeta(handle);
      }
      return;
    }

    if (!handle.sessionFilePath) {
      handle.sessionFilePath = await findCodexSessionFile(sessionId, this.options);
    }

    this.ensureJsonlWatcher(handle, handle.sessionFilePath);

    try {
      if (handle.parsedJsonlSessionId !== sessionId) {
        this.resetJsonlParsingState(handle, sessionId);
        handle.runtime.allMessages = [];
        handle.runtime.messages = [];
        handle.runtime.hasOlderMessages = false;
      }

      if (!handle.sessionFilePath) {
        handle.jsonlMissingSince ??= Date.now();
      } else {
        const stat = await fs.stat(handle.sessionFilePath);
        handle.lastJsonlActivityAt = Math.max(handle.lastJsonlActivityAt ?? 0, Math.floor(stat.mtimeMs));
        handle.jsonlMissingSince = null;

        if (handle.jsonlReadOffset > stat.size) {
          this.resetJsonlParsingState(handle, sessionId);
        }

        const { text, size } = await this.readJsonlTail(handle.sessionFilePath, handle.jsonlReadOffset);
        if (text) {
          const combined = `${handle.jsonlPendingLine}${text}`;
          const lines = combined.split('\n');
          const trailingLine = lines.pop() ?? '';

          for (const line of lines) {
            applyCodexJsonlLine(handle.jsonlMessagesState, line);
          }

          if (trailingLine.trim() && !applyCodexJsonlLine(handle.jsonlMessagesState, trailingLine)) {
            handle.jsonlPendingLine = trailingLine;
          } else {
            handle.jsonlPendingLine = '';
          }
        } else if (handle.jsonlPendingLine.trim() && applyCodexJsonlLine(handle.jsonlMessagesState, handle.jsonlPendingLine)) {
          handle.jsonlPendingLine = '';
        }

        handle.jsonlReadOffset = size;
      }

      const sawJsonlActivity = handle.jsonlMessagesState.activityRevision !== previousActivityRevision;
      if (sawJsonlActivity) {
        handle.awaitingJsonlTurn = false;
        handle.lastJsonlActivityAt = Date.now();
      }
      this.maybeClearStaleAwaitingTurn(handle);

      const nextAllMessages = materializeCodexJsonlMessages(handle.jsonlMessagesState);
      const nextMessages = this.selectRecentMessages(nextAllMessages);
      const nextHasOlderMessages = nextAllMessages.length > nextMessages.length;
      const nextRuntimeStatus = this.resolveRuntimeStatusFromState(handle, handle.jsonlMessagesState.runtimePhase);
      const allMessagesChanged = !messagesEqual(handle.runtime.allMessages, nextAllMessages);
      const messagesChanged = !messagesEqual(handle.runtime.messages, nextMessages);
      const hasOlderMessagesChanged = handle.runtime.hasOlderMessages !== nextHasOlderMessages;
      const statusChanged = previousStatus !== nextRuntimeStatus;

      if (allMessagesChanged) {
        handle.runtime.allMessages = nextAllMessages;
      }
      if (messagesChanged) {
        handle.runtime.messages = nextMessages;
      }
      if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
        handle.runtime.hasOlderMessages = nextHasOlderMessages;
      }
      if (statusChanged) {
        handle.runtime.status = nextRuntimeStatus;
        this.emitRuntimeMeta(handle);
      }

      if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged || statusChanged) {
        const upsertPayload = this.createMessagesUpsertPayload(
          handle,
          previousMessages,
          nextMessages,
          previousHasOlderMessages,
          nextHasOlderMessages
        );
        if (upsertPayload) {
          this.callbacks.emitMessagesUpsert(upsertPayload);
        }
      }

      if (this.shouldContinueJsonlRefresh(handle)) {
        this.scheduleJsonlRefresh(Math.max(this.options.jsonlRefreshDebounceMs, 250), 'refresh-loop');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        handle.jsonlMissingSince ??= Date.now();
        handle.sessionFilePath = null;
        this.ensureJsonlWatcher(handle, null);
        if (this.shouldContinueJsonlRefresh(handle)) {
          this.scheduleJsonlRefresh(Math.max(this.options.jsonlRefreshDebounceMs, 250), 'refresh-loop-missing-file');
        }
        return;
      }
      this.log('error', 'failed to refresh messages from codex jsonl', {
        ...this.handleContext(handle),
        code,
        error: errorMessage(error, 'Failed to read Codex jsonl'),
        jsonlReadOffset: handle.jsonlReadOffset
      });
      this.setLastError(handle, error instanceof Error ? error.message : 'Failed to read Codex jsonl');
    }
  }

  private scheduleJsonlRefresh(
    delayMs = this.options.jsonlRefreshDebounceMs,
    _reason = 'unspecified'
  ): void {
    const now = Date.now();
    const normalizedDelayMs = Math.max(0, delayMs);
    const nextDueAt = now + normalizedDelayMs;
    const existingDueAt = this.jsonlRefreshDueAt;

    if (this.jsonlRefreshTimer && existingDueAt !== null && nextDueAt >= existingDueAt) {
      return;
    }

    if (this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
    }

    this.jsonlRefreshDueAt = nextDueAt;
    this.jsonlRefreshTimer = setTimeout(() => {
      this.jsonlRefreshTimer = null;
      this.jsonlRefreshDueAt = null;
      const handle = this.getActiveHandle();
      if (!handle) {
        return;
      }
      void this.refreshMessagesFromJsonl(handle);
    }, normalizedDelayMs);
    this.jsonlRefreshTimer.unref();
  }

  private setStatus(handle: CodexHandle, nextStatus: RuntimeStatus): void {
    if (handle.runtime.status === nextStatus) {
      return;
    }

    handle.runtime.status = nextStatus;
    this.emitRuntimeMeta(handle);
  }

  private clearLastError(handle: CodexHandle): void {
    if (handle.runtime.lastError === null && handle.runtime.status !== 'error') {
      return;
    }

    handle.runtime.lastError = null;
    if (handle.runtime.status === 'error') {
      handle.runtime.status = this.resolveRuntimeStatusFromState(handle, handle.jsonlMessagesState.runtimePhase);
    }
    this.emitRuntimeMeta(handle);
  }

  private setLastError(handle: CodexHandle, nextError: string | null): void {
    if (handle.runtime.lastError === nextError && (nextError === null || handle.runtime.status === 'error')) {
      return;
    }

    handle.runtime.lastError = nextError;
    if (nextError !== null) {
      this.log('error', 'runtime entered error state', {
        ...this.handleContext(handle),
        lifecycle: handle.lifecycle,
        previousStatus: handle.runtime.status,
        runtimeError: nextError
      });
      handle.runtime.status = 'error';
      handle.lifecycle = 'error';
    }
    this.emitRuntimeMeta(handle);
  }

  private detachHandle(handle: CodexHandle): void {
    this.closeJsonlWatcher(handle);
    handle.lifecycle = handle.pty ? 'detached' : 'exited';
    handle.detachedAt = Date.now();
    this.log('info', handle.pty ? 'detached codex handle and kept pty cached' : 'detached codex handle without cached pty', {
      ...this.handleContext(handle),
      detachedAt: handle.detachedAt,
      runtimeStatus: handle.runtime.status
    });
    if (this.activeThreadKey === handle.threadKey) {
      this.activeThreadKey = null;
    }
    this.pruneInactiveHandleState(handle);
    if (handle.pty) {
      this.ensureJsonlWatcher(handle, handle.sessionFilePath);
    }
    if (this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
      this.jsonlRefreshTimer = null;
    }
    if (!handle.pty) {
      this.discardInactiveHandle(handle);
    }
  }

  private destroyHandle(handle: CodexHandle, reason: string): void {
    const wasActive = this.isActiveHandle(handle);
    const hadPty = handle.pty !== null;
    this.log('info', 'destroying codex handle', {
      ...this.handleContext(handle),
      destroyReason: reason,
      hadPty,
      wasActive,
      lifecycle: handle.lifecycle,
      runtimeStatus: handle.runtime.status
    });
    if (wasActive) {
      this.activeThreadKey = null;
      this.currentCwd = this.options.defaultCwd;
    }

    this.closeJsonlWatcher(handle);
    this.stopHandlePty(handle, reason);
    if (!hadPty) {
      this.emitTerminalSessionEvicted(handle, reason);
    }
    handle.terminalFrame.dispose();
    this.handles.delete(handle.threadKey);

    if (wasActive && this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
      this.jsonlRefreshTimer = null;
      this.jsonlRefreshDueAt = null;
    }
  }

  private resetTerminalReplay(handle: CodexHandle): void {
    handle.runtime.recentTerminalOutput = '';
    const patch = handle.terminalFrame.reset(handle.sessionId);
    if (handle.pty) {
      handle.pty.recentOutput = '';
    }
    if (this.isActiveHandle(handle)) {
      this.emitTerminalFramePatch(handle, patch);
    }
  }

  private stopHandlePty(handle: CodexHandle, reason: string, details?: Record<string, unknown>): void {
    const currentPty = handle.pty;
    if (!currentPty) {
      return;
    }

    this.log('info', 'stopping codex pty session', {
      ...this.handleContext(handle),
      stopReason: reason,
      lifecycle: handle.lifecycle,
      runtimeStatus: handle.runtime.status,
      ...details
    });
    handle.suppressNextPtyExitError = true;
    handle.expectedPtyExitReason = reason;
    handle.pty = null;
    handle.awaitingJsonlTurn = false;
    this.emitTerminalSessionEvicted(handle, reason);
    this.resetTerminalReplay(handle);
    stopCodexPtySession(currentPty);
    this.discardInactiveHandle(handle, { emitTerminalSessionEvicted: false });
  }

  private stopHandlePtyPreservingReplay(handle: CodexHandle, reason: string, details?: Record<string, unknown>): void {
    const currentPty = handle.pty;
    if (!currentPty) {
      return;
    }

    this.log('info', 'stopping codex pty session and preserving replay', {
      ...this.handleContext(handle),
      stopReason: reason,
      lifecycle: handle.lifecycle,
      runtimeStatus: handle.runtime.status,
      ...details
    });
    handle.suppressNextPtyExitError = true;
    handle.expectedPtyExitReason = reason;
    handle.pty = null;
    handle.awaitingJsonlTurn = false;
    stopCodexPtySession(currentPty);
  }

  private startHandleSession(handle: CodexHandle): void {
    this.resetTerminalReplay(handle);
    handle.suppressNextPtyExitError = false;
    handle.expectedPtyExitReason = null;
    handle.discoveryStartedAt = handle.sessionId ? null : Date.now();
    if (!handle.sessionId) {
      handle.sessionFilePath = null;
    }
    const token = ++handle.ptyToken;
    this.log('info', 'starting codex pty session', {
      ...this.handleContext(handle),
      cols: this.terminalSize.cols,
      rows: this.terminalSize.rows,
      token
    });
    const started = startCodexPtySession({
      cols: this.terminalSize.cols,
      cwd: handle.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      },
      resumeSessionId: handle.sessionId,
      rows: this.terminalSize.rows,
      onData: (chunk) => {
        if (token !== handle.ptyToken) {
          return;
        }
        this.handlePtyData(handle, chunk);
      },
      onExit: () => {
        if (token !== handle.ptyToken) {
          return;
        }
        void this.handlePtyExit(handle);
      }
    });

    handle.pty = started;
    handle.runtime.sessionId = handle.sessionId;
    const framePatch = handle.terminalFrame.reset(handle.sessionId);
    handle.runtime.status = 'starting';
    handle.lifecycle = this.isActiveHandle(handle) ? 'attached' : 'detached';
    this.emitRuntimeMeta(handle);
    if (this.isActiveHandle(handle)) {
      this.emitTerminalFramePatch(handle, framePatch);
      this.ensureJsonlWatcher(handle, handle.sessionFilePath);
      this.scheduleJsonlRefresh(0, 'start-handle-session');
    }
  }

  private async ensureHandleSession(handle: CodexHandle): Promise<void> {
    if (handle.pty) {
      return;
    }

    if (!handle.sessionId) {
      const prepared = await prepareCodexResumeSession(handle.cwd, this.options);
      handle.sessionId = prepared.sessionId;
      handle.sessionFilePath = prepared.filePath;
      handle.discoveryStartedAt = null;
      handle.jsonlMissingSince = null;
      handle.runtime.sessionId = prepared.sessionId;
      this.resetJsonlParsingState(handle, prepared.sessionId);
    }

    this.clearLastError(handle);
    this.startHandleSession(handle);
  }

  private handlePtyData(handle: CodexHandle, chunk: string): void {
    const session = handle.pty;
    if (!session) {
      return;
    }

    handle.runtime.recentTerminalOutput = appendRecentOutput(session, chunk, this.options.recentOutputMaxChars);
    handle.lastTerminalActivityAt = Date.now();
    const isActiveHandle = this.isActiveHandle(handle);

    void handle.terminalFrame
      .enqueueOutput(chunk)
      .then((patch) => {
        void this.autoHandleVisibleTerminalPrompts(handle).catch((error) => {
          this.log('warn', 'failed to auto-handle codex terminal prompt from visible frame', {
            ...this.handleContext(handle),
            error: errorMessage(error, 'Failed to auto-handle codex terminal prompt')
          });
        });
        if (patch) {
          this.emitTerminalFramePatch(handle, patch);
        }
        void this.maybeMarkHandleInterruptedFromTerminal(handle).catch((error) => {
          this.log('warn', 'failed to inspect codex terminal interrupt fallback', {
            ...this.handleContext(handle),
            error: errorMessage(error, 'Failed to inspect terminal interrupt fallback')
          });
        });
      })
      .catch((error) => {
        if (this.isActiveHandle(handle)) {
          this.setLastError(handle, errorMessage(error, 'Failed to materialize terminal frame'));
          return;
        }

        this.log('error', 'failed to materialize detached codex terminal frame', {
          ...this.handleContext(handle),
          error: errorMessage(error, 'Failed to materialize terminal frame')
        });
      });
    if (isActiveHandle) {
      this.scheduleJsonlRefresh(this.options.jsonlRefreshDebounceMs, 'pty-data');
    }
  }

  private emitTerminalFramePatch(handle: CodexHandle, patch: TerminalFramePatchPayload['patch']): void {
    this.callbacks.emitTerminalFramePatch({
      conversationKey: handle.threadKey,
      patch
    });
  }

  private async handlePtyExit(handle: CodexHandle): Promise<void> {
    const expectedExit = handle.suppressNextPtyExitError;
    const expectedExitReason = handle.expectedPtyExitReason;
    handle.suppressNextPtyExitError = false;
    handle.expectedPtyExitReason = null;
    handle.pty = null;
    handle.awaitingJsonlTurn = false;
    handle.lifecycle = 'exited';
    this.closeJsonlWatcher(handle);

    if (!this.isActiveHandle(handle)) {
      if (expectedExit) {
        this.log('info', 'inactive codex pty exited after requested stop', {
          ...this.handleContext(handle),
          stopReason: expectedExitReason ?? 'unknown',
          runtimeStatus: handle.runtime.status
        });
      }
      if (!expectedExit) {
        this.log('error', 'inactive codex pty exited unexpectedly', {
          ...this.handleContext(handle),
          recentOutputTail: tailForLog(handle.runtime.recentTerminalOutput),
          runtimeStatus: handle.runtime.status
        });
        handle.runtime.lastError = 'Codex CLI exited unexpectedly';
        handle.runtime.status = 'error';
        this.emitRuntimeMeta(handle);
      }
      try {
        await this.refreshMessagesFromJsonl(handle);
      } catch (error) {
        this.log('error', 'failed to finalize detached codex messages after pty exit', {
          ...this.handleContext(handle),
          error: errorMessage(error, 'Failed to finalize detached messages')
        });
      }
      this.discardInactiveHandle(handle);
      return;
    }

    this.scheduleJsonlRefresh(0, 'pty-exit');
    if (expectedExit) {
      this.log('info', 'active codex pty exited after requested stop', {
        ...this.handleContext(handle),
        stopReason: expectedExitReason ?? 'unknown',
        runtimeStatus: handle.runtime.status
      });
      this.setStatus(handle, 'idle');
      return;
    }
    this.log('error', 'active codex pty exited unexpectedly', {
      ...this.handleContext(handle),
      recentOutputTail: tailForLog(handle.runtime.recentTerminalOutput),
      runtimeStatus: handle.runtime.status
    });
    this.setLastError(handle, 'Codex CLI exited unexpectedly');
  }

  private async getHandleTerminalView(handle: CodexHandle): Promise<{
    bottomText: string;
    visibleText: string;
  }> {
    await handle.terminalFrame.flush();
    const snapshot = handle.terminalFrame.getSnapshot();
    const visibleLines = getVisibleTerminalFrameLines(snapshot);
    const trimmedVisibleLines = trimTrailingEmptyTerminalLines(visibleLines);
    const bottomLines = trimmedVisibleLines.slice(-TERMINAL_READY_BOTTOM_LINES);
    return {
      visibleText: materializeTerminalFrameLinesText(visibleLines),
      bottomText: materializeTerminalFrameLinesText(bottomLines)
    };
  }

  private restartHandleSessionForReadyRetry(handle: CodexHandle, attempt: number): void {
    this.log('warn', 'codex ready check timed out; restarting pty before retry', {
      ...this.handleContext(handle),
      attempt,
      maxRetries: READY_TIMEOUT_MAX_RETRIES,
      recentOutputTail: tailForLog(handle.pty?.recentOutput)
    });
    this.stopHandlePtyPreservingReplay(handle, 'ready-timeout-retry', {
      attempt,
      maxRetries: READY_TIMEOUT_MAX_RETRIES
    });
    this.startHandleSession(handle);
  }

  private async autoSkipUpdatePrompt(handle: CodexHandle, visibleText: string): Promise<boolean> {
    const session = handle.pty;
    if (!session || session.startupUpdatePromptHandled) {
      return false;
    }

    if (!looksLikeUpdatePrompt(visibleText)) {
      return false;
    }

    session.startupUpdatePromptHandled = true;
    this.log('info', 'auto-skipping codex update prompt', this.handleContext(handle));
    session.pty.write('\x1b[B');
    await sleep(120);
    if (handle.pty !== session) {
      return true;
    }
    session.pty.write('\r');
    await sleep(350);
    return true;
  }

  private async autoSelectExistingModelPrompt(handle: CodexHandle, visibleText: string): Promise<boolean> {
    const session = handle.pty;
    if (!session || session.startupModelChoicePromptHandled) {
      return false;
    }

    if (!looksLikeModelChoicePrompt(visibleText)) {
      return false;
    }

    session.startupModelChoicePromptHandled = true;
    this.log('info', 'auto-selecting existing codex model prompt option', this.handleContext(handle));
    session.pty.write('\x1b[B');
    await sleep(120);
    if (handle.pty !== session) {
      return true;
    }
    session.pty.write('\r');
    await sleep(350);
    return true;
  }

  private async autoAcceptDirectoryTrustPrompt(handle: CodexHandle, visibleText: string): Promise<boolean> {
    const session = handle.pty;
    if (!session || session.startupDirectoryTrustPromptHandled) {
      return false;
    }

    if (!looksLikeDirectoryTrustPrompt(visibleText)) {
      return false;
    }

    session.startupDirectoryTrustPromptHandled = true;
    this.log('info', 'auto-accepting codex directory trust prompt', this.handleContext(handle));
    session.pty.write('\r');
    await sleep(350);
    return true;
  }

  private async autoHandleVisibleTerminalPrompts(handle: CodexHandle): Promise<void> {
    if (!handle.pty) {
      return;
    }

    const { visibleText } = await this.getHandleTerminalView(handle);
    if (await this.autoAcceptDirectoryTrustPrompt(handle, visibleText)) {
      return;
    }
    if (await this.autoSelectExistingModelPrompt(handle, visibleText)) {
      return;
    }
    await this.autoSkipUpdatePrompt(handle, visibleText);
  }

  private async waitForHandleReadyWithRetry(handle: CodexHandle): Promise<void> {
    let retryCount = 0;

    while (true) {
      try {
        await this.waitForHandleReady(handle);
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Codex CLI startup timed out' || retryCount >= READY_TIMEOUT_MAX_RETRIES) {
          throw error;
        }
        retryCount += 1;
        this.restartHandleSessionForReadyRetry(handle, retryCount);
      }
    }
  }

  private async waitForHandleReady(handle: CodexHandle): Promise<void> {
    const deadline = Date.now() + this.options.codexReadyTimeoutMs;

    while (Date.now() < deadline) {
      if (!handle.pty) {
        throw new Error('Codex PTY session is not running');
      }

      const { bottomText, visibleText } = await this.getHandleTerminalView(handle);
      if (await this.autoAcceptDirectoryTrustPrompt(handle, visibleText)) {
        continue;
      }

      if (await this.autoSelectExistingModelPrompt(handle, visibleText)) {
        continue;
      }

      if (await this.autoSkipUpdatePrompt(handle, visibleText)) {
        continue;
      }

      if (looksReadyForInput(bottomText)) {
        return;
      }

      await sleep(250);
    }

    const { bottomText, visibleText } = await this.getHandleTerminalView(handle);
    this.log('error', 'codex startup timed out waiting for ready prompt', {
      ...this.handleContext(handle),
      readyTimeoutMs: this.options.codexReadyTimeoutMs,
      recentOutputTail: tailForLog(handle.pty?.recentOutput),
      terminalBottomText: bottomText,
      terminalVisibleText: visibleText
    });
    throw new Error('Codex CLI startup timed out');
  }

  private async sendPromptToHandle(handle: CodexHandle, content: string): Promise<void> {
    if (!handle.pty) {
      throw new Error('Codex PTY session is not running');
    }

    const { bottomText } = await this.getHandleTerminalView(handle);
    const shouldForceSubmit = showsStarterPrompt(bottomText);
    const normalizedContent = content.replace(/\r\n/g, '\n');
    handle.runtime.recentTerminalOutput = '';
    handle.pty.recentOutput = '';
    if (normalizedContent.includes('\n')) {
      handle.pty.pty.write('\x1b[200~');
      handle.pty.pty.write(normalizedContent);
      handle.pty.pty.write('\x1b[201~');
    } else {
      handle.pty.pty.write(normalizedContent);
    }

    await sleep(this.options.promptSubmitDelayMs);
    handle.pty.pty.write('\r');
    if (shouldForceSubmit) {
      await sleep(120);
      handle.pty.pty.write('\r');
    }
  }

  private async sendInterruptSequence(handle: CodexHandle): Promise<void> {
    if (!handle.pty) {
      return;
    }

    this.log('info', 'sending codex interrupt sequence', {
      ...this.handleContext(handle),
      runtimeStatus: handle.runtime.status
    });

    handle.pty.pty.write('\x1b');
  }

  private async maybeMarkHandleReadyAfterInterrupt(handle: CodexHandle): Promise<void> {
    await sleep(INTERRUPT_READY_CHECK_DELAY_MS);
    if (!this.isActiveHandle(handle) || !handle.pty) {
      return;
    }

    try {
      const { bottomText } = await this.getHandleTerminalView(handle);
      if (!looksReadyForInput(bottomText)) {
        return;
      }

      this.markHandleTurnInterrupted(handle, 'manual-interrupt');
    } catch (error) {
      this.log('warn', 'failed to confirm codex ready state after interrupt', {
        ...this.handleContext(handle),
        error: errorMessage(error, 'Failed to confirm ready state')
      });
    }
  }

  private getLastActivityAt(handle: CodexHandle): number {
    return Math.max(
      handle.lastJsonlActivityAt ?? 0,
      handle.lastTerminalActivityAt ?? 0,
      handle.lastUserInputAt ?? 0,
      handle.detachedAt ?? 0
    );
  }

  private pruneInactiveHandleState(handle: CodexHandle): void {
    if (this.isActiveHandle(handle)) {
      return;
    }
    if (handle.pty) {
      return;
    }

    handle.runtime.allMessages = [];
    handle.runtime.messages = [];
    handle.runtime.hasOlderMessages = false;
    handle.awaitingJsonlTurn = false;
    this.resetJsonlParsingState(handle, handle.sessionId);
  }

  private emitTerminalSessionEvicted(handle: CodexHandle, reason: string): void {
    const sessionId = handle.sessionId?.trim();
    if (!sessionId) {
      return;
    }
    this.callbacks.emitTerminalSessionEvicted({
      conversationKey: handle.threadKey,
      reason,
      sessionId
    });
  }

  private discardInactiveHandle(handle: CodexHandle, options: { emitTerminalSessionEvicted?: boolean } = {}): void {
    if (this.isActiveHandle(handle) || handle.pty) {
      return;
    }

    this.closeJsonlWatcher(handle);
    handle.lifecycle = 'exited';
    if (options.emitTerminalSessionEvicted !== false) {
      this.emitTerminalSessionEvicted(handle, 'discard-inactive-handle');
    }
    handle.terminalFrame.dispose();
    this.handles.delete(handle.threadKey);
  }

  private async gcDetachedHandles(): Promise<void> {
    const now = Date.now();
    const detachedHandles = [...this.handles.values()].filter((handle) => handle.lifecycle === 'detached' && handle.pty);

    for (const handle of detachedHandles) {
      if (handle.detachedAt && now - handle.detachedAt >= this.options.detachedPtyTtlMs) {
        this.stopHandlePty(handle, 'gc-detached-pty-ttl', {
          detachedForMs: now - handle.detachedAt
        });
        continue;
      }

      if (!handle.sessionId) {
        if (handle.detachedAt && now - handle.detachedAt >= this.options.detachedDraftTtlMs) {
          this.stopHandlePty(handle, 'gc-detached-draft-ttl', {
            detachedForMs: now - handle.detachedAt
          });
        }
        continue;
      }

      const filePath = handle.sessionFilePath ?? (await findCodexSessionFile(handle.sessionId, this.options));
      handle.sessionFilePath = filePath;

      if (!filePath) {
        handle.jsonlMissingSince ??= now;
        if (now - handle.jsonlMissingSince >= this.options.detachedJsonlMissingTtlMs) {
          this.stopHandlePty(handle, 'gc-detached-jsonl-missing-ttl', {
            jsonlMissingForMs: now - handle.jsonlMissingSince
          });
        }
        continue;
      }

      try {
        const stat = await fs.stat(filePath);
        handle.lastJsonlActivityAt = Math.max(handle.lastJsonlActivityAt ?? 0, Math.floor(stat.mtimeMs));
        handle.jsonlMissingSince = null;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          continue;
        }
        handle.jsonlMissingSince ??= now;
        if (now - handle.jsonlMissingSince >= this.options.detachedJsonlMissingTtlMs) {
          this.stopHandlePty(handle, 'gc-detached-jsonl-missing-ttl', {
            jsonlMissingForMs: now - handle.jsonlMissingSince
          });
        }
      }
    }

    const survivors = [...this.handles.values()]
      .filter((handle) => handle.lifecycle === 'detached' && handle.pty)
      .sort((left, right) => this.getLastActivityAt(left) - this.getLastActivityAt(right));

    while (survivors.length > this.options.maxDetachedPtys) {
      const victim = survivors.shift();
      if (!victim) {
        break;
      }
      this.stopHandlePty(victim, 'gc-max-detached-ptys', {
        maxDetachedPtys: this.options.maxDetachedPtys
      });
    }
  }
}
