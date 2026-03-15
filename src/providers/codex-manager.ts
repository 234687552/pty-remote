import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';

import type {
  GetOlderMessagesResultPayload,
  MessagesUpsertPayload,
  SelectConversationResultPayload,
  TerminalChunkPayload
} from '../../shared/protocol.ts';
import type { ChatMessage, ProviderId, RuntimeSnapshot, RuntimeStatus } from '../../shared/runtime-types.ts';
import {
  applyCodexJsonlLine,
  createCodexJsonlMessagesState,
  materializeCodexJsonlMessages,
  refreshCodexJsonlMessageStatuses,
  type CodexJsonlMessagesState,
  type CodexJsonlRuntimePhase
} from './codex-jsonl.ts';
import {
  appendRecentOutput,
  appendReplayChunk,
  getCodexPtyLifecycle,
  looksLikeDirectoryTrustPrompt,
  looksReadyForInput,
  resizeCodexPtySession,
  showsStarterPrompt,
  startCodexPtySession,
  stopCodexPtySession,
  type CodexPtySession
} from './codex-pty.ts';
import { prepareCodexResumeSession } from './codex-resume-session.ts';
import { findCodexSessionFile, findLatestCodexSessionForCwdSince, type CodexHistoryOptions } from './codex-history.ts';

export interface CodexManagerOptions extends CodexHistoryOptions {
  codexBin: string;
  defaultCwd: string;
  terminalCols: number;
  terminalRows: number;
  terminalReplayMaxBytes: number;
  recentOutputMaxChars: number;
  codexReadyTimeoutMs: number;
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

interface CodexManagerCallbacks {
  emitMessagesUpsert(payload: Omit<MessagesUpsertPayload, 'cliId'>): void;
  emitSnapshot(snapshot: RuntimeSnapshot): void;
  emitTerminalChunk(payload: Omit<TerminalChunkPayload, 'cliId' | 'providerId'>): void;
}

export interface CodexManagerSelection {
  cwd: string;
  label: string;
  sessionId: string | null;
  conversationKey: string;
}

interface AgentRuntimeState extends RuntimeSnapshot {
  allMessages: ChatMessage[];
  terminalOffset: number;
  terminalReplay: string;
}

type HandleLifecycle = 'attached' | 'detached' | 'exited' | 'error';

interface CodexHandle {
  threadKey: string;
  cwd: string;
  label: string;
  sessionId: string | null;
  sessionFilePath: string | null;
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
  runtime: AgentRuntimeState;
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

export class CodexManager {
  private readonly providerId: ProviderId = 'codex';

  private readonly callbacks: CodexManagerCallbacks;

  private readonly handles = new Map<string, CodexHandle>();

  private readonly options: CodexManagerOptions;

  private activeThreadKey: string | null = null;

  private currentCwd: string;

  private jsonlRefreshTimer: NodeJS.Timeout | null = null;

  private snapshotEmitTimer: NodeJS.Timeout | null = null;

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

  getSnapshot(): RuntimeSnapshot {
    return this.createRuntimeSnapshot(this.getActiveHandle());
  }

  async replayActiveState(): Promise<void> {
    await this.refreshActiveMessages();
    this.emitActiveTerminalReplay(this.getActiveHandle());
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
    resizeCodexPtySession(handle?.pty ?? null, nextCols, nextRows);
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

    if (handle.sessionId && !handle.pty) {
      this.startHandleSession(handle);
    } else {
      this.ensureJsonlWatcher(handle, handle.sessionFilePath);
    }

    await this.refreshMessagesFromJsonl(handle);
    this.emitActiveTerminalReplay(handle);
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
    if (this.isBusyStatus(handle.runtime.status)) {
      throw new Error('Codex is still handling the previous message');
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
      this.setStatus(handle, 'idle', true);
      this.setLastError(handle, error instanceof Error ? error.message : 'Codex request failed');
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
      refreshCodexJsonlMessageStatuses(handle.jsonlMessagesState);
    }

    const nextAllMessages = materializeCodexJsonlMessages(handle.jsonlMessagesState);
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

    this.stopHandlePtyPreservingReplay(handle);
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
    this.stopHandlePty(handle);
    handle.sessionId = null;
    handle.sessionFilePath = null;
    this.resetHandleRuntime(handle, null);
    handle.lifecycle = 'attached';
    handle.detachedAt = null;
    handle.discoveryStartedAt = null;
    this.emitSnapshotNow();
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
      this.stopHandlePty(handle);
    }
  }

  private createHandle(selection: CodexManagerSelection): CodexHandle {
    return {
      threadKey: selection.conversationKey,
      cwd: selection.cwd,
      label: selection.label,
      sessionId: selection.sessionId,
      sessionFilePath: null,
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
      runtime: this.createFreshState(selection.conversationKey, selection.sessionId),
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
      terminalReplay: '',
      terminalOffset: 0,
      messages: [],
      hasOlderMessages: false,
      lastError: null
    };
  }

  private emitActiveTerminalReplay(handle: CodexHandle | null): void {
    if (!handle) {
      return;
    }

    this.callbacks.emitTerminalChunk({
      conversationKey: handle.threadKey,
      data: handle.runtime.terminalReplay,
      offset: 0,
      sessionId: handle.sessionId
    });
  }

  private createRuntimeSnapshot(handle: CodexHandle | null): RuntimeSnapshot {
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
    const cwd = path.resolve(selection.cwd);
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
    if (!this.isActiveHandle(handle)) {
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
        if (!this.isActiveHandle(handle) || handle.sessionFilePath !== filePath) {
          return;
        }
        if (typeof changedFileName === 'string' && changedFileName.length > 0 && changedFileName !== fileName) {
          return;
        }
        this.scheduleJsonlRefresh(0);
      });
      handle.watchedJsonlFilePath = filePath;
      handle.jsonlWatcher.on('error', (error) => {
        if (!this.isActiveHandle(handle) || handle.sessionFilePath !== filePath) {
          return;
        }
        this.closeJsonlWatcher(handle);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return;
        }
        this.setLastError(handle, error instanceof Error ? error.message : 'Failed to watch Codex jsonl');
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return;
      }
      this.setLastError(handle, error instanceof Error ? error.message : 'Failed to watch Codex jsonl');
    }
  }

  private resolveRuntimeStatusFromState(handle: CodexHandle, runtimePhase: CodexJsonlRuntimePhase): RuntimeStatus {
    if (handle.runtime.lastError !== null && handle.runtime.status === 'error') {
      return 'error';
    }

    const ptyLifecycle = handle.pty ? getCodexPtyLifecycle(handle.pty.recentOutput) : 'not_ready';
    if (runtimePhase === 'running' || handle.awaitingJsonlTurn || ptyLifecycle === 'running') {
      return 'running';
    }

    if (handle.pty && ptyLifecycle === 'not_ready' && handle.runtime.allMessages.length === 0) {
      return 'starting';
    }

    return 'idle';
  }

  private shouldContinueJsonlRefresh(handle: CodexHandle): boolean {
    if (!this.isActiveHandle(handle) || !handle.pty) {
      return false;
    }

    return handle.awaitingJsonlTurn || handle.runtime.status === 'starting' || handle.runtime.status === 'running';
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

    if (this.isActiveHandle(handle)) {
      this.ensureJsonlWatcher(handle, match.filePath);
      this.emitSnapshotNow();
    }
  }

  private async refreshActiveMessages(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }

    await this.refreshMessagesFromJsonl(handle);
  }

  private async refreshMessagesFromJsonl(handle: CodexHandle): Promise<void> {
    await this.discoverSessionForHandle(handle);

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
        this.emitSnapshotNow();
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
          nextHasOlderMessages
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
        handle.sessionFilePath = null;
        this.ensureJsonlWatcher(handle, null);
        if (this.shouldContinueJsonlRefresh(handle)) {
          this.scheduleJsonlRefresh(Math.max(this.options.jsonlRefreshDebounceMs, 250));
        }
        return;
      }
      this.setLastError(handle, error instanceof Error ? error.message : 'Failed to read Codex jsonl');
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

  private setStatus(handle: CodexHandle, nextStatus: RuntimeStatus, immediate = false): void {
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

  private clearLastError(handle: CodexHandle): void {
    if (handle.runtime.lastError === null && handle.runtime.status !== 'error') {
      return;
    }

    handle.runtime.lastError = null;
    if (handle.runtime.status === 'error') {
      handle.runtime.status = this.resolveRuntimeStatusFromState(handle, handle.jsonlMessagesState.runtimePhase);
    }
    if (this.isActiveHandle(handle)) {
      this.emitSnapshotNow();
    }
  }

  private setLastError(handle: CodexHandle, nextError: string | null): void {
    if (handle.runtime.lastError === nextError && (nextError === null || handle.runtime.status === 'error')) {
      return;
    }

    handle.runtime.lastError = nextError;
    if (nextError !== null) {
      handle.runtime.status = 'error';
      handle.lifecycle = 'error';
    }
    if (this.isActiveHandle(handle)) {
      this.emitSnapshotNow();
    }
  }

  private detachHandle(handle: CodexHandle): void {
    this.closeJsonlWatcher(handle);
    handle.lifecycle = handle.pty ? 'detached' : 'exited';
    handle.detachedAt = Date.now();
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

  private resetTerminalReplay(handle: CodexHandle): void {
    handle.runtime.terminalReplay = '';
    handle.runtime.terminalOffset = 0;
    if (handle.pty) {
      handle.pty.recentOutput = '';
      handle.pty.replayBytes = 0;
      handle.pty.replayChunks = [];
    }
  }

  private stopHandlePty(handle: CodexHandle): void {
    const currentPty = handle.pty;
    if (!currentPty) {
      return;
    }

    handle.suppressNextPtyExitError = true;
    handle.pty = null;
    handle.awaitingJsonlTurn = false;
    this.resetTerminalReplay(handle);
    stopCodexPtySession(currentPty);
    this.discardInactiveHandle(handle);
  }

  private stopHandlePtyPreservingReplay(handle: CodexHandle): void {
    const currentPty = handle.pty;
    if (!currentPty) {
      return;
    }

    handle.suppressNextPtyExitError = true;
    handle.pty = null;
    handle.awaitingJsonlTurn = false;
    stopCodexPtySession(currentPty);
  }

  private startHandleSession(handle: CodexHandle): void {
    this.resetTerminalReplay(handle);
    handle.suppressNextPtyExitError = false;
    handle.discoveryStartedAt = handle.sessionId ? null : Date.now();
    if (!handle.sessionId) {
      handle.sessionFilePath = null;
    }
    const token = ++handle.ptyToken;
    const started = startCodexPtySession({
      codexBin: this.options.codexBin,
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
    handle.runtime.status = 'starting';
    handle.lifecycle = this.isActiveHandle(handle) ? 'attached' : 'detached';
    if (this.isActiveHandle(handle)) {
      this.ensureJsonlWatcher(handle, handle.sessionFilePath);
      this.emitSnapshotNow();
      this.scheduleJsonlRefresh(0);
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

    const chunkOffset = handle.runtime.terminalOffset;
    handle.runtime.terminalReplay = appendReplayChunk(session, chunk, this.options.terminalReplayMaxBytes);
    handle.runtime.terminalOffset += Buffer.byteLength(chunk, 'utf8');
    appendRecentOutput(session, chunk, this.options.recentOutputMaxChars);
    handle.lastTerminalActivityAt = Date.now();

    if (!this.isActiveHandle(handle)) {
      return;
    }

    this.callbacks.emitTerminalChunk({
      conversationKey: handle.threadKey,
      data: chunk,
      offset: chunkOffset,
      sessionId: handle.sessionId
    });
    this.scheduleJsonlRefresh();
  }

  private async handlePtyExit(handle: CodexHandle): Promise<void> {
    const expectedExit = handle.suppressNextPtyExitError;
    handle.suppressNextPtyExitError = false;
    handle.pty = null;
    handle.awaitingJsonlTurn = false;
    handle.lifecycle = 'exited';
    this.closeJsonlWatcher(handle);

    if (!this.isActiveHandle(handle)) {
      if (!expectedExit) {
        handle.runtime.lastError = 'Codex CLI exited unexpectedly';
      }
      this.discardInactiveHandle(handle);
      return;
    }

    this.scheduleJsonlRefresh(0);
    if (expectedExit) {
      this.setStatus(handle, 'idle', true);
      return;
    }
    this.setLastError(handle, 'Codex CLI exited unexpectedly');
  }

  private async waitForHandleReady(handle: CodexHandle): Promise<void> {
    const deadline = Date.now() + this.options.codexReadyTimeoutMs;

    while (Date.now() < deadline) {
      if (!handle.pty) {
        throw new Error('Codex PTY session is not running');
      }

      if (looksReadyForInput(handle.pty.recentOutput)) {
        return;
      }

      if (looksLikeDirectoryTrustPrompt(handle.pty.recentOutput)) {
        handle.pty.pty.write('\r');
        await sleep(350);
        continue;
      }

      await sleep(250);
    }

    throw new Error('Codex CLI startup timed out');
  }

  private async sendPromptToHandle(handle: CodexHandle, content: string): Promise<void> {
    if (!handle.pty) {
      throw new Error('Codex PTY session is not running');
    }

    const shouldForceSubmit = showsStarterPrompt(handle.pty.recentOutput);
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
    if (shouldForceSubmit) {
      await sleep(120);
      handle.pty.pty.write('\r');
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

    handle.runtime.allMessages = [];
    handle.runtime.messages = [];
    handle.runtime.hasOlderMessages = false;
    handle.awaitingJsonlTurn = false;
    this.resetJsonlParsingState(handle, handle.sessionId);
  }

  private discardInactiveHandle(handle: CodexHandle): void {
    if (this.isActiveHandle(handle) || handle.pty) {
      return;
    }

    this.closeJsonlWatcher(handle);
    handle.lifecycle = 'exited';
    this.handles.delete(handle.threadKey);
  }

  private async gcDetachedHandles(): Promise<void> {
    const now = Date.now();
    const detachedHandles = [...this.handles.values()].filter((handle) => handle.lifecycle === 'detached' && handle.pty);

    for (const handle of detachedHandles) {
      if (handle.detachedAt && now - handle.detachedAt >= this.options.detachedPtyTtlMs) {
        this.stopHandlePty(handle);
        continue;
      }

      if (!handle.sessionId) {
        if (handle.detachedAt && now - handle.detachedAt >= this.options.detachedDraftTtlMs) {
          this.stopHandlePty(handle);
        }
        continue;
      }

      const filePath = handle.sessionFilePath ?? (await findCodexSessionFile(handle.sessionId, this.options));
      handle.sessionFilePath = filePath;

      if (!filePath) {
        handle.jsonlMissingSince ??= now;
        if (now - handle.jsonlMissingSince >= this.options.detachedJsonlMissingTtlMs) {
          this.stopHandlePty(handle);
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
          this.stopHandlePty(handle);
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
      this.stopHandlePty(victim);
    }
  }
}
