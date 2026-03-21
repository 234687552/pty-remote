import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  GetOlderMessagesResultPayload,
  ManagedPtyHandleSummary,
  MessagesUpsertPayload,
  SelectConversationResultPayload,
  TerminalFramePatchPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ChatMessage, ProviderId, RuntimeSnapshot, RuntimeStatus } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import {
  applyClaudeJsonlLine,
  createClaudeJsonlMessagesState,
  materializeClaudeJsonlMessages,
  resolveClaudeJsonlFilePath,
  type ClaudeJsonlMessagesState,
  type ClaudeJsonlRuntimePhase
} from './jsonl.ts';
import {
  appendRecentOutput,
  looksLikeBypassPrompt,
  looksReadyForInput,
  resizeClaudePtySession,
  startClaudePtySession,
  stopClaudePtySession,
  type ClaudePtySession
} from './pty.ts';
import { HeadlessTerminalFrameState } from '../terminal/frame-state.ts';

export interface PtyManagerOptions {
  claudeBin: string;
  permissionMode: string;
  defaultCwd: string;
  terminalCols: number;
  terminalRows: number;
  terminalFrameScrollback: number;
  recentOutputMaxChars: number;
  claudeReadyTimeoutMs: number;
  promptSubmitDelayMs: number;
  jsonlRefreshDebounceMs: number;
  snapshotEmitDebounceMs: number;
  snapshotMessagesMax: number;
  olderMessagesPageMax: number;
  gcIntervalMs: number;
  detachedDraftTtlMs: number;
  detachedJsonlMissingTtlMs: number;
  detachedPtyTtlMs: number;
  maxDetachedPtys: number;
}

interface PtyManagerCallbacks {
  emitMessagesUpsert(payload: Omit<MessagesUpsertPayload, 'cliId'>): void;
  emitSnapshot(snapshot: RuntimeSnapshot): void;
  emitTerminalFramePatch(payload: Omit<TerminalFramePatchPayload, 'cliId' | 'providerId'>): void;
  emitTerminalSessionEvicted(payload: {
    conversationKey: string | null;
    reason: string;
    sessionId: string;
  }): void;
}

export interface PtyManagerSelection {
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

interface PtyHandle {
  threadKey: string;
  cwd: string;
  label: string;
  sessionId: string | null;
  lifecycle: HandleLifecycle;
  pty: ClaudePtySession | null;
  ptyToken: number;
  jsonlWatcher: FSWatcher | null;
  watchedJsonlSessionId: string | null;
  jsonlMessagesState: ClaudeJsonlMessagesState;
  parsedJsonlSessionId: string | null;
  jsonlReadOffset: number;
  jsonlPendingLine: string;
  awaitingJsonlTurn: boolean;
  suppressNextPtyExitError: boolean;
  expectedPtyExitReason: string | null;
  runtime: AgentRuntimeState;
  terminalFrame: HeadlessTerminalFrameState;
  detachedAt: number | null;
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

export class PtyManager {
  private readonly providerId: ProviderId = 'claude';

  private readonly handles = new Map<string, PtyHandle>();

  private readonly callbacks: PtyManagerCallbacks;

  private readonly options: PtyManagerOptions;

  private activeThreadKey: string | null = null;

  private currentCwd: string;

  private jsonlRefreshTimer: NodeJS.Timeout | null = null;

  private snapshotEmitTimer: NodeJS.Timeout | null = null;

  private gcTimer: NodeJS.Timeout;

  private terminalSize: { cols: number; rows: number };

  constructor(options: PtyManagerOptions, callbacks: PtyManagerCallbacks) {
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
      logger(`[pty-remote][claude] ${message}`, details);
      return;
    }
    logger(`[pty-remote][claude] ${message}`);
  }

  private handleContext(handle: PtyHandle): Record<string, unknown> {
    return {
      conversationKey: handle.threadKey,
      cwd: handle.cwd,
      sessionId: handle.sessionId
    };
  }

  getRegistrationPayload(): {
    cwd: string;
    sessionId: string | null;
    conversationKey: string | null;
  } {
    const handle = this.getActiveHandle();
    return {
      cwd: handle?.cwd ?? this.currentCwd,
      sessionId: handle?.sessionId ?? null,
      conversationKey: handle?.threadKey ?? null
    };
  }

  getSnapshot(): RuntimeSnapshot {
    return this.createRuntimeSnapshot(this.getActiveHandle());
  }

  async primeActiveTerminalFrame(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      throw new Error('No active terminal is selected');
    }
    this.emitActiveTerminalFrame(handle);
  }

  async refreshActiveState(): Promise<void> {
    await this.refreshActiveMessages();
    this.emitSnapshotNow();
  }

  updateTerminalSize(cols: number, rows: number): void {
    const nextCols = Number.isFinite(cols) ? Math.max(20, Math.min(Math.floor(cols), 400)) : this.terminalSize.cols;
    const nextRows = Number.isFinite(rows) ? Math.max(8, Math.min(Math.floor(rows), 200)) : this.terminalSize.rows;
    this.terminalSize = {
      cols: nextCols,
      rows: nextRows
    };

    const handle = this.getActiveHandle();
    resizeClaudePtySession(handle?.pty ?? null, nextCols, nextRows);
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

  async activateConversation(selection: PtyManagerSelection): Promise<SelectConversationResultPayload> {
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

    await this.refreshMessagesFromJsonl(handle);

    if (!handle.pty) {
      this.startHandleSession(handle, { emitSnapshot: false });
    } else {
      this.ensureJsonlWatcher(handle, handle.sessionId);
    }

    this.emitSnapshotNow();

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
    if (handle.runtime.status === 'running' || handle.awaitingJsonlTurn) {
      throw new Error('Claude is still handling the previous message');
    }

    await this.ensureHandleSession(handle);

    try {
      await this.waitForHandleReady(handle);
      handle.awaitingJsonlTurn = true;
      handle.lastUserInputAt = Date.now();
      this.setStatus(handle, 'running', true);
      await this.sendPromptToHandle(handle, trimmedContent);
      this.scheduleJsonlRefresh(0);
    } catch (error) {
      this.log('error', 'dispatchMessage failed', {
        ...this.handleContext(handle),
        error: errorMessage(error, 'Claude request failed'),
        promptLength: trimmedContent.length
      });
      this.setStatus(handle, 'idle', true);
      this.setLastError(handle, error instanceof Error ? error.message : 'Claude request failed');
      throw error;
    }
  }

  async stopActiveRun(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle || !this.isBusyStatus(handle.runtime.status)) {
      return;
    }

    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;

    this.clearLastError(handle);
    handle.awaitingJsonlTurn = false;
    if (handle.jsonlMessagesState.runtimePhase !== 'idle') {
      handle.jsonlMessagesState.runtimePhase = 'idle';
      handle.jsonlMessagesState.activityRevision += 1;
    }

    const nextAllMessages = this.applyStreamingStatus(materializeClaudeJsonlMessages(handle.jsonlMessagesState), false);
    const nextMessages = this.selectRecentMessages(nextAllMessages);
    const nextHasOlderMessages = nextAllMessages.length > nextMessages.length;
    const allMessagesChanged = !messagesEqual(handle.runtime.allMessages, nextAllMessages);
    const messagesChanged = !messagesEqual(handle.runtime.messages, nextMessages);
    const hasOlderMessagesChanged = handle.runtime.hasOlderMessages !== nextHasOlderMessages;

    if (allMessagesChanged) {
      handle.runtime.allMessages = nextAllMessages;
    }
    if (messagesChanged) {
      handle.runtime.messages = nextMessages;
    }
    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
      handle.runtime.hasOlderMessages = nextHasOlderMessages;
    }

    this.stopHandlePtyPreservingReplay(handle, 'stop-active-run');
    this.setStatus(handle, 'idle', true);

    if (this.isActiveHandle(handle) && (allMessagesChanged || messagesChanged || hasOlderMessagesChanged)) {
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

    this.scheduleJsonlRefresh(0);
  }

  async resetActiveThread(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }

    this.closeJsonlWatcher(handle);
    this.stopHandlePty(handle, 'reset-session');
    handle.sessionId = null;
    this.resetHandleRuntime(handle, null);
    handle.lifecycle = 'attached';
    handle.detachedAt = null;
    this.emitSnapshotNow();
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

  async getOlderMessages(beforeMessageId?: string, maxMessages = this.options.olderMessagesPageMax): Promise<GetOlderMessagesResultPayload> {
    await this.refreshActiveMessages();
    const handle = this.getActiveHandle();
    if (!handle) {
      return {
        messages: [],
        providerId: null,
        conversationKey: null,
        sessionId: null,
        hasOlderMessages: false
      };
    }

    const normalizedMaxMessages = Number.isFinite(maxMessages)
      ? Math.max(1, Math.min(Math.floor(maxMessages), this.options.olderMessagesPageMax))
      : this.options.olderMessagesPageMax;
    const allMessages = handle.runtime.allMessages;
    const boundaryIndex = beforeMessageId ? allMessages.findIndex((message) => message.id === beforeMessageId) : allMessages.length;
    const end = boundaryIndex >= 0 ? boundaryIndex : allMessages.length;
    const start = Math.max(0, end - normalizedMaxMessages);

    return {
      messages: cloneValue(allMessages.slice(start, end)),
      providerId: this.providerId,
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      hasOlderMessages: start > 0
    };
  }

  async shutdown(): Promise<void> {
    if (this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
      this.jsonlRefreshTimer = null;
    }
    if (this.snapshotEmitTimer) {
      clearTimeout(this.snapshotEmitTimer);
      this.snapshotEmitTimer = null;
    }

    clearInterval(this.gcTimer);
    for (const handle of this.handles.values()) {
      this.closeJsonlWatcher(handle);
      this.stopHandlePty(handle, 'shutdown');
    }
  }

  private createHandle(selection: PtyManagerSelection): PtyHandle {
    return {
      threadKey: selection.conversationKey,
      cwd: selection.cwd,
      label: selection.label,
      sessionId: selection.sessionId,
      lifecycle: 'exited',
      pty: null,
      ptyToken: 0,
      jsonlWatcher: null,
      watchedJsonlSessionId: null,
      jsonlMessagesState: createClaudeJsonlMessagesState(),
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

  private emitActiveTerminalFrame(handle: PtyHandle | null): void {
    if (!handle) {
      return;
    }

    this.emitTerminalFramePatch(handle, handle.terminalFrame.createResetPatch());
  }

  private createRuntimeSnapshot(handle: PtyHandle | null): RuntimeSnapshot {
    if (!handle) {
      return {
        providerId: null,
        conversationKey: null,
        status: 'idle',
        sessionId: null,
        messages: [],
        hasOlderMessages: false,
        lastError: null
      };
    }

    return {
      providerId: this.providerId,
      conversationKey: handle.threadKey,
      status: handle.runtime.status,
      sessionId: handle.runtime.sessionId,
      messages: cloneValue(handle.runtime.messages),
      hasOlderMessages: handle.runtime.hasOlderMessages,
      lastError: handle.runtime.lastError
    };
  }

  private getActiveHandle(): PtyHandle | null {
    if (!this.activeThreadKey) {
      return null;
    }

    return this.handles.get(this.activeThreadKey) ?? null;
  }

  private isActiveHandle(handle: PtyHandle): boolean {
    return this.activeThreadKey === handle.threadKey;
  }

  private isBusyStatus(status: RuntimeStatus): boolean {
    return status === 'starting' || status === 'running';
  }

  private async normalizeSelection(selection: PtyManagerSelection): Promise<PtyManagerSelection> {
    const resolvedCwd = await this.normalizeProjectCwd(selection.cwd);
    const stat = await fs.stat(resolvedCwd);
    if (!stat.isDirectory()) {
      throw new Error('Selected project is not a directory');
    }

    return {
      cwd: resolvedCwd,
      label: selection.label.trim() || path.basename(resolvedCwd) || resolvedCwd,
      sessionId: selection.sessionId,
      conversationKey: selection.conversationKey
    };
  }

  private async normalizeProjectCwd(cwd: string): Promise<string> {
    const resolvedCwd = path.resolve(cwd);
    return fs.realpath(resolvedCwd).catch(() => resolvedCwd);
  }

  private syncHandleSelection(handle: PtyHandle, selection: PtyManagerSelection): void {
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
      this.resetJsonlParsingState(handle, selection.sessionId);
    }
  }

  private resetJsonlParsingState(handle: PtyHandle, sessionId: string | null): void {
    handle.jsonlMessagesState = createClaudeJsonlMessagesState();
    handle.parsedJsonlSessionId = sessionId;
    handle.jsonlReadOffset = 0;
    handle.jsonlPendingLine = '';
  }

  private resetHandleRuntime(handle: PtyHandle, sessionId: string | null): void {
    handle.runtime = this.createFreshState(handle.threadKey, sessionId);
    handle.sessionId = sessionId;
    handle.awaitingJsonlTurn = false;
    handle.jsonlMissingSince = null;
    handle.lastJsonlActivityAt = null;
    handle.lastTerminalActivityAt = null;
    handle.lastUserInputAt = null;
    this.resetJsonlParsingState(handle, sessionId);
  }

  private closeJsonlWatcher(handle: PtyHandle): void {
    if (!handle.jsonlWatcher) {
      return;
    }

    handle.jsonlWatcher.close();
    handle.jsonlWatcher = null;
    handle.watchedJsonlSessionId = null;
  }

  private ensureJsonlWatcher(handle: PtyHandle, sessionId: string | null): void {
    if (!this.isActiveHandle(handle)) {
      this.closeJsonlWatcher(handle);
      return;
    }

    if (!sessionId) {
      this.closeJsonlWatcher(handle);
      return;
    }

    if (handle.jsonlWatcher && handle.watchedJsonlSessionId === sessionId) {
      return;
    }

    this.closeJsonlWatcher(handle);

    const filePath = this.resolveSessionJsonlFilePath(handle, sessionId);
    const dirPath = path.dirname(filePath);
    const fileName = path.basename(filePath);

    try {
      handle.jsonlWatcher = watchFs(dirPath, { persistent: false }, (_eventType, changedFileName) => {
        if (!this.isActiveHandle(handle) || handle.sessionId !== sessionId) {
          return;
        }
        if (typeof changedFileName === 'string' && changedFileName.length > 0 && changedFileName !== fileName) {
          return;
        }
        this.scheduleJsonlRefresh(0);
      });
      handle.watchedJsonlSessionId = sessionId;
      handle.jsonlWatcher.on('error', (error) => {
        if (!this.isActiveHandle(handle) || handle.sessionId !== sessionId) {
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
          error: errorMessage(error, 'Failed to watch Claude jsonl'),
          filePath
        });
        this.setLastError(handle, error instanceof Error ? error.message : 'Failed to watch Claude jsonl');
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
        error: errorMessage(error, 'Failed to watch Claude jsonl'),
        filePath
      });
      this.setLastError(handle, error instanceof Error ? error.message : 'Failed to watch Claude jsonl');
    }
  }

  private resolveSessionJsonlFilePath(handle: PtyHandle, sessionId: string): string {
    return resolveClaudeJsonlFilePath(handle.cwd, sessionId, os.homedir());
  }

  private resolveRuntimeStatusFromJsonl(handle: PtyHandle, runtimePhase: ClaudeJsonlRuntimePhase): RuntimeStatus {
    if (handle.runtime.lastError !== null && handle.runtime.status === 'error') {
      return 'error';
    }

    if (runtimePhase === 'running' || handle.awaitingJsonlTurn) {
      return 'running';
    }

    return 'idle';
  }

  private shouldContinueJsonlRefresh(handle: PtyHandle): boolean {
    if (!this.isActiveHandle(handle) || !handle.pty) {
      return false;
    }

    return handle.awaitingJsonlTurn || handle.runtime.status === 'starting' || handle.runtime.status === 'running';
  }

  private maybeClearStaleAwaitingTurn(handle: PtyHandle): void {
    if (!handle.awaitingJsonlTurn || !handle.lastUserInputAt) {
      return;
    }

    const elapsedMs = Date.now() - handle.lastUserInputAt;
    if (elapsedMs < AWAITING_JSONL_TURN_STALE_MS) {
      return;
    }

    handle.awaitingJsonlTurn = false;
  }

  private applyStreamingStatus(messages: ChatMessage[], isRunning: boolean): ChatMessage[] {
    if (!isRunning) {
      return messages;
    }

    const lastAssistantIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant');
    if (lastAssistantIndex < 0) {
      return messages;
    }

    const targetIndex = messages.length - 1 - lastAssistantIndex;
    const targetMessage = messages[targetIndex];
    if (!targetMessage || targetMessage.status === 'error' || targetMessage.status === 'streaming') {
      return messages;
    }

    const nextMessages = messages.slice();
    nextMessages[targetIndex] = {
      ...targetMessage,
      status: 'streaming'
    };
    return nextMessages;
  }

  private selectRecentMessages(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= this.options.snapshotMessagesMax) {
      return messages;
    }
    return messages.slice(-this.options.snapshotMessagesMax);
  }

  private createMessagesUpsertPayload(
    handle: PtyHandle,
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

  private async refreshActiveMessages(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }

    await this.refreshMessagesFromJsonl(handle);
  }

  private async refreshMessagesFromJsonl(handle: PtyHandle): Promise<void> {
    const sessionId = handle.sessionId;
    if (!sessionId) {
      this.closeJsonlWatcher(handle);
      if (this.isActiveHandle(handle) && handle.runtime.status !== 'idle') {
        handle.runtime.status = 'idle';
        this.emitSnapshotNow();
      }
      return;
    }

    this.ensureJsonlWatcher(handle, sessionId);

    const filePath = this.resolveSessionJsonlFilePath(handle, sessionId);
    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;
    const previousStatus = handle.runtime.status;
    const previousActivityRevision = handle.jsonlMessagesState.activityRevision;

    try {
      if (handle.parsedJsonlSessionId !== sessionId) {
        this.resetJsonlParsingState(handle, sessionId);
        handle.runtime.allMessages = [];
        handle.runtime.messages = [];
        handle.runtime.hasOlderMessages = false;
      }

      const stat = await fs.stat(filePath);
      handle.lastJsonlActivityAt = Math.max(handle.lastJsonlActivityAt ?? 0, Math.floor(stat.mtimeMs));
      handle.jsonlMissingSince = null;

      if (handle.jsonlReadOffset > stat.size) {
        this.resetJsonlParsingState(handle, sessionId);
      }

      const { text, size } = await this.readJsonlTail(filePath, handle.jsonlReadOffset);
      if (text) {
        const combined = `${handle.jsonlPendingLine}${text}`;
        const lines = combined.split('\n');
        const trailingLine = lines.pop() ?? '';

        for (const line of lines) {
          applyClaudeJsonlLine(handle.jsonlMessagesState, line);
        }

        if (trailingLine.trim() && !applyClaudeJsonlLine(handle.jsonlMessagesState, trailingLine)) {
          handle.jsonlPendingLine = trailingLine;
        } else {
          handle.jsonlPendingLine = '';
        }
      } else if (handle.jsonlPendingLine.trim() && applyClaudeJsonlLine(handle.jsonlMessagesState, handle.jsonlPendingLine)) {
        handle.jsonlPendingLine = '';
      }

      handle.jsonlReadOffset = size;
      const sawJsonlActivity = handle.jsonlMessagesState.activityRevision !== previousActivityRevision;
      if (sawJsonlActivity) {
        handle.awaitingJsonlTurn = false;
        handle.lastJsonlActivityAt = Date.now();
      }
      this.maybeClearStaleAwaitingTurn(handle);

      const nextRuntimeStatus = this.resolveRuntimeStatusFromJsonl(handle, handle.jsonlMessagesState.runtimePhase);
      const nextAllMessages = this.applyStreamingStatus(
        materializeClaudeJsonlMessages(handle.jsonlMessagesState),
        handle.jsonlMessagesState.runtimePhase === 'running'
      );
      const nextMessages = this.selectRecentMessages(nextAllMessages);
      const allMessagesChanged = !messagesEqual(handle.runtime.allMessages, nextAllMessages);
      const messagesChanged = !messagesEqual(handle.runtime.messages, nextMessages);
      const hasOlderMessagesChanged = handle.runtime.hasOlderMessages !== (nextAllMessages.length > nextMessages.length);
      const statusChanged = previousStatus !== nextRuntimeStatus;

      if (allMessagesChanged) {
        handle.runtime.allMessages = nextAllMessages;
      }
      if (messagesChanged) {
        handle.runtime.messages = nextMessages;
      }
      if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
        handle.runtime.hasOlderMessages = nextAllMessages.length > nextMessages.length;
      }
      if (statusChanged) {
        handle.runtime.status = nextRuntimeStatus;
      }

      if (!this.isActiveHandle(handle)) {
        return;
      }

      if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged || statusChanged) {
        const upsertPayload = this.createMessagesUpsertPayload(
          handle,
          previousMessages,
          nextMessages,
          previousHasOlderMessages,
          nextAllMessages.length > nextMessages.length
        );
        if (upsertPayload) {
          this.callbacks.emitMessagesUpsert(upsertPayload);
        }
        this.scheduleSnapshotEmit(statusChanged ? 0 : this.options.snapshotEmitDebounceMs);
      }

      if (this.shouldContinueJsonlRefresh(handle)) {
        this.scheduleJsonlRefresh(Math.max(this.options.jsonlRefreshDebounceMs, 250));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        handle.jsonlMissingSince ??= Date.now();
        if (this.shouldContinueJsonlRefresh(handle)) {
          this.scheduleJsonlRefresh(Math.max(this.options.jsonlRefreshDebounceMs, 250));
        }
        return;
      }
      this.log('error', 'failed to refresh messages from claude jsonl', {
        ...this.handleContext(handle),
        code,
        error: errorMessage(error, 'Failed to read Claude jsonl'),
        jsonlReadOffset: handle.jsonlReadOffset
      });
      this.setLastError(handle, error instanceof Error ? error.message : 'Failed to read Claude jsonl');
    }
  }

  private scheduleJsonlRefresh(delayMs = this.options.jsonlRefreshDebounceMs): void {
    if (this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
    }

    this.jsonlRefreshTimer = setTimeout(() => {
      this.jsonlRefreshTimer = null;
      const handle = this.getActiveHandle();
      if (!handle) {
        return;
      }
      void this.refreshMessagesFromJsonl(handle);
    }, delayMs);
  }

  private scheduleSnapshotEmit(delayMs = this.options.snapshotEmitDebounceMs): void {
    if (this.snapshotEmitTimer) {
      clearTimeout(this.snapshotEmitTimer);
    }

    this.snapshotEmitTimer = setTimeout(() => {
      this.snapshotEmitTimer = null;
      this.emitSnapshotNow();
    }, delayMs);
  }

  private emitSnapshotNow(): void {
    this.callbacks.emitSnapshot(this.createRuntimeSnapshot(this.getActiveHandle()));
  }

  private setStatus(handle: PtyHandle, nextStatus: RuntimeStatus, immediate = false): void {
    if (handle.runtime.status === nextStatus) {
      return;
    }

    handle.runtime.status = nextStatus;
    if (!this.isActiveHandle(handle)) {
      return;
    }
    if (immediate) {
      this.emitSnapshotNow();
      return;
    }
    this.scheduleSnapshotEmit();
  }

  private clearLastError(handle: PtyHandle): void {
    if (handle.runtime.lastError === null && handle.runtime.status !== 'error') {
      return;
    }

    handle.runtime.lastError = null;
    if (handle.runtime.status === 'error') {
      handle.runtime.status = this.resolveRuntimeStatusFromJsonl(handle, handle.jsonlMessagesState.runtimePhase);
    }
    if (this.isActiveHandle(handle)) {
      this.emitSnapshotNow();
    }
  }

  private setLastError(handle: PtyHandle, nextError: string | null): void {
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
    if (this.isActiveHandle(handle)) {
      this.emitSnapshotNow();
    }
  }

  private detachHandle(handle: PtyHandle): void {
    this.closeJsonlWatcher(handle);
    handle.lifecycle = handle.pty ? 'detached' : 'exited';
    handle.detachedAt = Date.now();
    this.log('info', handle.pty ? 'detached claude handle and kept pty cached' : 'detached claude handle without cached pty', {
      ...this.handleContext(handle),
      detachedAt: handle.detachedAt,
      runtimeStatus: handle.runtime.status
    });
    if (this.activeThreadKey === handle.threadKey) {
      this.activeThreadKey = null;
    }
    this.pruneInactiveHandleState(handle);
    if (this.jsonlRefreshTimer) {
      clearTimeout(this.jsonlRefreshTimer);
      this.jsonlRefreshTimer = null;
    }
    if (!handle.pty) {
      this.discardInactiveHandle(handle);
    }
  }

  private destroyHandle(handle: PtyHandle, reason: string): void {
    const wasActive = this.isActiveHandle(handle);
    const hadPty = handle.pty !== null;
    this.log('info', 'destroying claude handle', {
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

    if (wasActive) {
      if (this.jsonlRefreshTimer) {
        clearTimeout(this.jsonlRefreshTimer);
        this.jsonlRefreshTimer = null;
      }
      this.emitSnapshotNow();
    }
  }

  private resetTerminalReplay(handle: PtyHandle): void {
    handle.runtime.recentTerminalOutput = '';
    const patch = handle.terminalFrame.reset(handle.sessionId);
    if (handle.pty) {
      handle.pty.recentOutput = '';
    }
    if (this.isActiveHandle(handle)) {
      this.emitTerminalFramePatch(handle, patch);
    }
  }

  private stopHandlePty(handle: PtyHandle, reason: string, details?: Record<string, unknown>): void {
    const currentPty = handle.pty;
    if (!currentPty) {
      return;
    }

    this.log('info', 'stopping claude pty session', {
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
    stopClaudePtySession(currentPty);
    this.discardInactiveHandle(handle, { emitTerminalSessionEvicted: false });
  }

  private stopHandlePtyPreservingReplay(handle: PtyHandle, reason: string, details?: Record<string, unknown>): void {
    const currentPty = handle.pty;
    if (!currentPty) {
      return;
    }

    this.log('info', 'stopping claude pty session and preserving replay', {
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
    stopClaudePtySession(currentPty);
  }

  private startHandleSession(handle: PtyHandle, options?: { emitSnapshot?: boolean }): void {
    this.resetTerminalReplay(handle);
    handle.suppressNextPtyExitError = false;
    handle.expectedPtyExitReason = null;
    const token = ++handle.ptyToken;
    this.log('info', 'starting claude pty session', {
      ...this.handleContext(handle),
      cols: this.terminalSize.cols,
      rows: this.terminalSize.rows,
      token
    });
    const started = startClaudePtySession({
      claudeBin: this.options.claudeBin,
      cols: this.terminalSize.cols,
      cwd: handle.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      },
      permissionMode: this.options.permissionMode,
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

    handle.pty = started.session;
    handle.sessionId = started.sessionId;
    handle.runtime.sessionId = started.sessionId;
    const framePatch = handle.terminalFrame.reset(started.sessionId);
    handle.runtime.status = 'starting';
    handle.lifecycle = this.isActiveHandle(handle) ? 'attached' : 'detached';
    if (this.isActiveHandle(handle)) {
      this.emitTerminalFramePatch(handle, framePatch);
      this.ensureJsonlWatcher(handle, started.sessionId);
      if (options?.emitSnapshot !== false) {
        this.emitSnapshotNow();
      }
      this.scheduleJsonlRefresh(0);
    }
  }

  private async ensureHandleSession(handle: PtyHandle): Promise<void> {
    if (handle.pty) {
      return;
    }

    this.clearLastError(handle);
    this.startHandleSession(handle);
  }

  private handlePtyData(handle: PtyHandle, chunk: string): void {
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
        if (patch && this.isActiveHandle(handle)) {
          this.emitTerminalFramePatch(handle, patch);
        }
      })
      .catch((error) => {
        if (this.isActiveHandle(handle)) {
          this.setLastError(handle, errorMessage(error, 'Failed to materialize terminal frame'));
          return;
        }

        this.log('error', 'failed to materialize detached claude terminal frame', {
          ...this.handleContext(handle),
          error: errorMessage(error, 'Failed to materialize terminal frame')
        });
      });
    if (isActiveHandle) {
      this.scheduleJsonlRefresh();
    }
  }

  private emitTerminalFramePatch(handle: PtyHandle, patch: TerminalFramePatchPayload['patch']): void {
    this.callbacks.emitTerminalFramePatch({
      conversationKey: handle.threadKey,
      patch
    });
  }

  private async handlePtyExit(handle: PtyHandle): Promise<void> {
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
        this.log('info', 'inactive claude pty exited after requested stop', {
          ...this.handleContext(handle),
          stopReason: expectedExitReason ?? 'unknown',
          runtimeStatus: handle.runtime.status
        });
      }
      if (!expectedExit) {
        this.log('error', 'inactive claude pty exited unexpectedly', {
          ...this.handleContext(handle),
          recentOutputTail: tailForLog(handle.runtime.recentTerminalOutput),
          runtimeStatus: handle.runtime.status
        });
        handle.runtime.lastError = 'Claude CLI exited unexpectedly';
      }
      this.discardInactiveHandle(handle);
      return;
    }

    this.scheduleJsonlRefresh(0);
    if (expectedExit) {
      this.log('info', 'active claude pty exited after requested stop', {
        ...this.handleContext(handle),
        stopReason: expectedExitReason ?? 'unknown',
        runtimeStatus: handle.runtime.status
      });
      this.setStatus(handle, 'idle', true);
      return;
    }
    this.log('error', 'active claude pty exited unexpectedly', {
      ...this.handleContext(handle),
      recentOutputTail: tailForLog(handle.runtime.recentTerminalOutput),
      runtimeStatus: handle.runtime.status
    });
    this.setLastError(handle, 'Claude CLI exited unexpectedly');
  }

  private async autoAcceptBypassPrompt(handle: PtyHandle): Promise<boolean> {
    if (!handle.pty) {
      return false;
    }

    if (!looksLikeBypassPrompt(handle.pty.recentOutput)) {
      return false;
    }

    handle.pty.pty.write('\x1b[B');
    await sleep(120);
    handle.pty.pty.write('\r');
    await sleep(320);
    return true;
  }

  private async waitForHandleReady(handle: PtyHandle): Promise<void> {
    const deadline = Date.now() + this.options.claudeReadyTimeoutMs;

    while (Date.now() < deadline) {
      if (!handle.pty) {
        throw new Error('Claude PTY session is not running');
      }

      const currentText = handle.pty.recentOutput;
      if (looksReadyForInput(currentText)) {
        return;
      }

      if (await this.autoAcceptBypassPrompt(handle)) {
        continue;
      }

      await sleep(250);
    }

    this.log('error', 'claude startup timed out waiting for ready prompt', {
      ...this.handleContext(handle),
      readyTimeoutMs: this.options.claudeReadyTimeoutMs,
      recentOutputTail: tailForLog(handle.pty?.recentOutput)
    });
    throw new Error('Claude CLI startup timed out');
  }

  private async sendPromptToHandle(handle: PtyHandle, content: string): Promise<void> {
    if (!handle.pty) {
      throw new Error('Claude PTY session is not running');
    }

    const needsPromptRefocus = /⏵⏵\s*bypass permissions on/i.test(handle.pty.recentOutput);
    if (needsPromptRefocus) {
      // Claude can leave keyboard focus on the bypass-permissions toggle after a turn.
      // Shift+Tab cycles focus back to the prompt input before typing.
      handle.pty.pty.write('\x1b[Z');
      await sleep(120);
    }

    const normalizedContent = content.replace(/\r\n/g, '\n');
    if (normalizedContent.includes('\n')) {
      handle.pty.pty.write('\x1b[200~');
      handle.pty.pty.write(normalizedContent);
      handle.pty.pty.write('\x1b[201~');
    } else {
      handle.pty.pty.write(normalizedContent);
    }

    await sleep(this.options.promptSubmitDelayMs);
    handle.pty.pty.write('\r');
  }

  private getLastActivityAt(handle: PtyHandle): number {
    return Math.max(
      handle.lastJsonlActivityAt ?? 0,
      handle.lastTerminalActivityAt ?? 0,
      handle.lastUserInputAt ?? 0,
      handle.detachedAt ?? 0
    );
  }

  private pruneInactiveHandleState(handle: PtyHandle): void {
    if (this.isActiveHandle(handle)) {
      return;
    }

    handle.runtime.allMessages = [];
    handle.runtime.messages = [];
    handle.runtime.hasOlderMessages = false;
    handle.awaitingJsonlTurn = false;
    this.resetJsonlParsingState(handle, handle.sessionId);
  }

  private emitTerminalSessionEvicted(handle: PtyHandle, reason: string): void {
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

  private discardInactiveHandle(handle: PtyHandle, options: { emitTerminalSessionEvicted?: boolean } = {}): void {
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

      const filePath = this.resolveSessionJsonlFilePath(handle, handle.sessionId);
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
