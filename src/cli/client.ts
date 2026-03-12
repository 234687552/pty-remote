import { randomUUID } from 'node:crypto';
import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io, type Socket } from 'socket.io-client';
import type {
  CliCommandEnvelope,
  CliCommandResult,
  GetOlderMessagesResultPayload,
  GetRawJsonlResultPayload,
  GetRuntimeSnapshotResultPayload,
  CliRegisterResult,
  MessagesUpsertPayload,
  RuntimeSnapshotPayload,
  SelectThreadResultPayload,
  TerminalChunkPayload
} from '../../shared/protocol.ts';
import type { ChatMessage, RuntimeSnapshot, RuntimeStatus } from '../../shared/runtime-types.ts';
import {
  applyClaudeJsonlLine,
  createClaudeJsonlMessagesState,
  materializeClaudeJsonlMessages,
  resolveClaudeJsonlFilePath,
  type ClaudeJsonlRuntimePhase,
  type ClaudeJsonlMessagesState
} from './jsonl.ts';
import {
  appendRecentOutput,
  appendReplayChunk,
  type ClaudePtySession,
  looksLikeBypassPrompt,
  looksReadyForInput,
  resizeClaudePtySession,
  startClaudePtySession,
  stopClaudePtySession
} from './pty.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../..');

const SOCKET_URL = process.env.SOCKET_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '3001'}`;
const CLI_ID = (process.env.HAPI_TMUX_CLI_ID ?? `${path.basename(DEFAULT_ROOT_DIR)}-${randomUUID().slice(0, 8)}`)
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, '-');
const PTY_BACKEND_NAME = 'node-pty';
const TERMINAL_REPLAY_MAX_BYTES = 1024 * 1024;
const RECENT_OUTPUT_MAX_CHARS = 12_000;
const CLAUDE_READY_TIMEOUT_MS = 20_000;
const PROMPT_SUBMIT_DELAY_MS = 120;
const JSONL_REFRESH_DEBOUNCE_MS = 120;
const SNAPSHOT_EMIT_DEBOUNCE_MS = 200;
const SNAPSHOT_MESSAGES_MAX = 40;
const OLDER_MESSAGES_PAGE_MAX = 40;
const RAW_JSONL_MAX_CHARS = 200_000;
const CLAUDE_PERMISSION_MODE = sanitizePermissionMode(process.env.CLAUDE_PERMISSION_MODE);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/claude' : 'claude');
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 32;

interface AgentRuntimeState extends RuntimeSnapshot {
  allMessages: ChatMessage[];
  rawJsonl: string;
  terminalReplay: string;
  terminalOffset: number;
}

interface ActiveThreadTarget {
  cwd: string;
  label: string;
  resumeSessionId: string | null;
}

let state: AgentRuntimeState = createFreshState();
let claudePty: ClaudePtySession | null = null;
let claudePtyToken = 0;
let socketClient: Socket | null = null;
let jsonlRefreshTimer: NodeJS.Timeout | null = null;
let snapshotEmitTimer: NodeJS.Timeout | null = null;
let jsonlWatcher: FSWatcher | null = null;
let watchedJsonlSessionId: string | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let suppressNextPtyExitError = false;
let jsonlMessagesState: ClaudeJsonlMessagesState = createClaudeJsonlMessagesState();
let parsedJsonlSessionId: string | null = null;
let jsonlReadOffset = 0;
let jsonlPendingLine = '';
let awaitingJsonlTurn = false;
let activeThreadTarget: ActiveThreadTarget = {
  cwd: DEFAULT_ROOT_DIR,
  label: (process.env.HAPI_TMUX_CLI_LABEL ?? path.basename(DEFAULT_ROOT_DIR) ?? 'claude-cli').trim(),
  resumeSessionId: null
};
let terminalSize = {
  cols: TERMINAL_COLS,
  rows: TERMINAL_ROWS
};

function sanitizePermissionMode(value: string | undefined): string {
  const allowed = new Set(['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']);
  if (value && allowed.has(value)) {
    return value;
  }
  return 'bypassPermissions';
}

function createFreshState(): AgentRuntimeState {
  return {
    status: 'idle',
    sessionId: null,
    allMessages: [],
    terminalReplay: '',
    terminalOffset: 0,
    messages: [],
    hasOlderMessages: false,
    lastError: null,
    rawJsonl: ''
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function resetJsonlParsingState(sessionId: string | null): void {
  jsonlMessagesState = createClaudeJsonlMessagesState();
  parsedJsonlSessionId = sessionId;
  jsonlReadOffset = 0;
  jsonlPendingLine = '';
}

function getThreadLabel(cwd: string): string {
  return path.basename(cwd) || cwd;
}

function normalizeThreadTarget(cwd: string, sessionId: string | null): ActiveThreadTarget {
  const normalizedCwd = path.resolve(cwd);
  return {
    cwd: normalizedCwd,
    label: getThreadLabel(normalizedCwd),
    resumeSessionId: sessionId
  };
}

function resetRuntimeState(sessionId: string | null = null): void {
  state = createFreshState();
  state.sessionId = sessionId;
  awaitingJsonlTurn = false;
  resetJsonlParsingState(sessionId);
}

function stopActivePty(): void {
  const currentPty = claudePty;
  if (!currentPty) {
    return;
  }

  claudePtyToken += 1;
  claudePty = null;
  suppressNextPtyExitError = true;
  stopClaudePtySession(currentPty);
}

function updateTerminalSize(cols: number, rows: number): void {
  const nextCols = Number.isFinite(cols) ? Math.max(20, Math.min(Math.floor(cols), 400)) : terminalSize.cols;
  const nextRows = Number.isFinite(rows) ? Math.max(8, Math.min(Math.floor(rows), 200)) : terminalSize.rows;
  terminalSize = {
    cols: nextCols,
    rows: nextRows
  };
  resizeClaudePtySession(claudePty, nextCols, nextRows);
}

function createRuntimeSnapshot(): RuntimeSnapshot {
  return {
    status: state.status,
    sessionId: state.sessionId,
    messages: cloneValue(state.messages),
    hasOlderMessages: state.hasOlderMessages,
    lastError: state.lastError
  };
}

function emitSnapshot(): void {
  if (!socketClient?.connected) {
    return;
  }

  socketClient.emit('cli:snapshot', {
    snapshot: createRuntimeSnapshot()
  } satisfies RuntimeSnapshotPayload);
}

function emitMessagesUpsert(payload: MessagesUpsertPayload): void {
  if (!socketClient?.connected) {
    return;
  }

  socketClient.emit('cli:messages-upsert', payload);
}

function scheduleSnapshotEmit(delayMs = SNAPSHOT_EMIT_DEBOUNCE_MS): void {
  if (snapshotEmitTimer) {
    clearTimeout(snapshotEmitTimer);
  }

  snapshotEmitTimer = setTimeout(() => {
    snapshotEmitTimer = null;
    emitSnapshot();
  }, delayMs);
}

function isActiveStatus(status: RuntimeStatus): boolean {
  return status === 'starting' || status === 'running';
}

function setStatus(nextStatus: RuntimeStatus, immediate = false): void {
  if (state.status === nextStatus) {
    return;
  }

  state.status = nextStatus;
  if (immediate) {
    emitSnapshot();
    return;
  }

  scheduleSnapshotEmit();
}

function clearLastError(): void {
  if (state.lastError === null && state.status !== 'error') {
    return;
  }

  state.lastError = null;
  if (state.status === 'error') {
    state.status = resolveRuntimeStatusFromJsonl(jsonlMessagesState.runtimePhase);
  }
  emitSnapshot();
}

function setLastError(nextError: string | null): void {
  if (state.lastError === nextError && (nextError === null || state.status === 'error')) {
    return;
  }

  state.lastError = nextError;
  if (nextError !== null) {
    state.status = 'error';
  }
  emitSnapshot();
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

function closeJsonlWatcher(): void {
  if (!jsonlWatcher) {
    return;
  }

  jsonlWatcher.close();
  jsonlWatcher = null;
  watchedJsonlSessionId = null;
}

function resolveSessionJsonlFilePath(sessionId: string): string {
  return resolveClaudeJsonlFilePath(activeThreadTarget.cwd, sessionId, os.homedir());
}

function ensureJsonlWatcher(sessionId: string | null): void {
  if (!sessionId) {
    closeJsonlWatcher();
    return;
  }

  if (jsonlWatcher && watchedJsonlSessionId === sessionId) {
    return;
  }

  closeJsonlWatcher();

  const filePath = resolveSessionJsonlFilePath(sessionId);
  const dirPath = path.dirname(filePath);
  const fileName = path.basename(filePath);

  try {
    jsonlWatcher = watchFs(dirPath, { persistent: false }, (_eventType, changedFileName) => {
      if (state.sessionId !== sessionId) {
        return;
      }
      if (typeof changedFileName === 'string' && changedFileName.length > 0 && changedFileName !== fileName) {
        return;
      }
      scheduleJsonlRefresh(0);
    });
    watchedJsonlSessionId = sessionId;
    jsonlWatcher.on('error', (error) => {
      if (state.sessionId !== sessionId) {
        return;
      }
      closeJsonlWatcher();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return;
      }
      setLastError(error instanceof Error ? error.message : 'Failed to watch Claude jsonl');
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    setLastError(error instanceof Error ? error.message : 'Failed to watch Claude jsonl');
  }
}

function resolveRuntimeStatusFromJsonl(runtimePhase: ClaudeJsonlRuntimePhase): RuntimeStatus {
  if (state.lastError !== null && state.status === 'error') {
    return 'error';
  }

  if (runtimePhase === 'running' || awaitingJsonlTurn) {
    return 'running';
  }

  if (claudePty && state.status === 'starting' && state.allMessages.length === 0) {
    return 'starting';
  }

  return 'idle';
}

function applyStreamingStatus(messages: ChatMessage[], isRunning: boolean): ChatMessage[] {
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

function selectRecentMessages(messages: ChatMessage[], maxMessages = SNAPSHOT_MESSAGES_MAX): ChatMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  return messages.slice(-maxMessages);
}

function createRawJsonlResult(maxChars = RAW_JSONL_MAX_CHARS): GetRawJsonlResultPayload {
  const normalizedMaxChars = Number.isFinite(maxChars) ? Math.max(1, Math.min(Math.floor(maxChars), RAW_JSONL_MAX_CHARS)) : RAW_JSONL_MAX_CHARS;
  const rawJsonl = state.rawJsonl;

  if (rawJsonl.length <= normalizedMaxChars) {
    return {
      rawJsonl,
      sessionId: state.sessionId,
      truncated: false
    };
  }

  return {
    rawJsonl: rawJsonl.slice(-normalizedMaxChars),
    sessionId: state.sessionId,
    truncated: true
  };
}

function createOlderMessagesResult(
  beforeMessageId: string | undefined,
  maxMessages = OLDER_MESSAGES_PAGE_MAX
): GetOlderMessagesResultPayload {
  const normalizedMaxMessages = Number.isFinite(maxMessages)
    ? Math.max(1, Math.min(Math.floor(maxMessages), OLDER_MESSAGES_PAGE_MAX))
    : OLDER_MESSAGES_PAGE_MAX;
  const allMessages = state.allMessages;
  const boundaryIndex = beforeMessageId ? allMessages.findIndex((message) => message.id === beforeMessageId) : allMessages.length;
  const end = boundaryIndex >= 0 ? boundaryIndex : allMessages.length;
  const start = Math.max(0, end - normalizedMaxMessages);

  return {
    messages: cloneValue(allMessages.slice(start, end)),
    sessionId: state.sessionId,
    hasOlderMessages: start > 0
  };
}

function createMessagesUpsertPayload(
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
  sessionId: string | null,
  previousHasOlderMessages: boolean,
  hasOlderMessages: boolean
): MessagesUpsertPayload | null {
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
    sessionId,
    upserts: cloneValue(upserts),
    recentMessageIds: nextIds,
    hasOlderMessages
  };
}

async function readJsonlTail(filePath: string, startOffset: number): Promise<{ text: string; size: number }> {
  const stat = await fs.stat(filePath);
  if (startOffset >= stat.size) {
    return {
      text: '',
      size: stat.size
    };
  }

  const handle = await fs.open(filePath, 'r');

  try {
    const length = stat.size - startOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, startOffset);
    return {
      text: buffer.toString('utf8'),
      size: stat.size
    };
  } finally {
    await handle.close();
  }
}

function messagesEqual(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => messageEqual(message, right[index]));
}

async function refreshMessagesFromJsonl(): Promise<void> {
  const sessionId = state.sessionId;
  if (!sessionId) {
    closeJsonlWatcher();
    if (state.allMessages.length > 0 || state.messages.length > 0 || state.status !== 'idle' || state.rawJsonl) {
      resetJsonlParsingState(null);
      state.allMessages = [];
      state.messages = [];
      state.status = 'idle';
      state.hasOlderMessages = false;
      state.rawJsonl = '';
      emitSnapshot();
    }
    return;
  }

  ensureJsonlWatcher(sessionId);

  const filePath = resolveSessionJsonlFilePath(sessionId);
  const previousMessages = state.messages;
  const previousHasOlderMessages = state.hasOlderMessages;
  const previousStatus = state.status;
  const previousActivityRevision = jsonlMessagesState.activityRevision;

  try {
    if (parsedJsonlSessionId !== sessionId) {
      resetJsonlParsingState(sessionId);
      state.rawJsonl = '';
      state.allMessages = [];
      state.messages = [];
      state.hasOlderMessages = false;
    }

    const stat = await fs.stat(filePath);
    if (jsonlReadOffset > stat.size) {
      resetJsonlParsingState(sessionId);
      state.rawJsonl = '';
    }

    const { text, size } = await readJsonlTail(filePath, jsonlReadOffset);
    if (text) {
      state.rawJsonl += text;
      const combined = `${jsonlPendingLine}${text}`;
      const lines = combined.split('\n');
      const trailingLine = lines.pop() ?? '';

      for (const line of lines) {
        applyClaudeJsonlLine(jsonlMessagesState, line);
      }

      if (trailingLine.trim() && !applyClaudeJsonlLine(jsonlMessagesState, trailingLine)) {
        jsonlPendingLine = trailingLine;
      } else {
        jsonlPendingLine = '';
      }
    } else if (jsonlPendingLine.trim() && applyClaudeJsonlLine(jsonlMessagesState, jsonlPendingLine)) {
      jsonlPendingLine = '';
    }

    jsonlReadOffset = size;
    const sawJsonlActivity = jsonlMessagesState.activityRevision !== previousActivityRevision;
    if (sawJsonlActivity) {
      awaitingJsonlTurn = false;
    }

    const nextRuntimeStatus = resolveRuntimeStatusFromJsonl(jsonlMessagesState.runtimePhase);
    const nextAllMessages = applyStreamingStatus(
      materializeClaudeJsonlMessages(jsonlMessagesState),
      jsonlMessagesState.runtimePhase === 'running'
    );
    const nextMessages = selectRecentMessages(nextAllMessages);
    const allMessagesChanged = !messagesEqual(state.allMessages, nextAllMessages);
    const messagesChanged = !messagesEqual(state.messages, nextMessages);
    const hasOlderMessagesChanged = state.hasOlderMessages !== (nextAllMessages.length > nextMessages.length);
    const statusChanged = previousStatus !== nextRuntimeStatus;

    if (allMessagesChanged) {
      state.allMessages = nextAllMessages;
    }
    if (messagesChanged) {
      state.messages = nextMessages;
    }
    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
      state.hasOlderMessages = nextAllMessages.length > nextMessages.length;
    }
    if (statusChanged) {
      state.status = nextRuntimeStatus;
    }

    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged || statusChanged) {
      const upsertPayload = createMessagesUpsertPayload(
        previousMessages,
        nextMessages,
        sessionId,
        previousHasOlderMessages,
        nextAllMessages.length > nextMessages.length
      );
      if (upsertPayload) {
        emitMessagesUpsert(upsertPayload);
      }
      scheduleSnapshotEmit(statusChanged ? 0 : SNAPSHOT_EMIT_DEBOUNCE_MS);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (state.rawJsonl) {
        state.rawJsonl = '';
      }
      return;
    }
    setLastError(error instanceof Error ? error.message : 'Failed to read Claude jsonl');
  }
}

function scheduleJsonlRefresh(delayMs = JSONL_REFRESH_DEBOUNCE_MS): void {
  if (jsonlRefreshTimer) {
    clearTimeout(jsonlRefreshTimer);
  }

  jsonlRefreshTimer = setTimeout(() => {
    jsonlRefreshTimer = null;
    void refreshMessagesFromJsonl();
  }, delayMs);
}

function emitTerminalChunk(data: string, offset: number): void {
  if (!socketClient?.connected) {
    return;
  }

  socketClient.emit('cli:terminal-chunk', {
    data,
    offset,
    sessionId: state.sessionId
  } satisfies TerminalChunkPayload);
}

function handlePtyData(chunk: string): void {
  const session = claudePty;
  if (!session) {
    return;
  }

  const chunkOffset = state.terminalOffset;
  state.terminalReplay = appendReplayChunk(session, chunk, TERMINAL_REPLAY_MAX_BYTES);
  state.terminalOffset += Buffer.byteLength(chunk, 'utf8');
  appendRecentOutput(session, chunk, RECENT_OUTPUT_MAX_CHARS);
  emitTerminalChunk(chunk, chunkOffset);
  scheduleJsonlRefresh();
}

async function handlePtyExit(): Promise<void> {
  const expectedExit = suppressNextPtyExitError;
  suppressNextPtyExitError = false;
  claudePty = null;
  awaitingJsonlTurn = false;
  scheduleJsonlRefresh(0);
  if (expectedExit) {
    setStatus('idle', true);
    return;
  }
  setLastError('Claude CLI exited unexpectedly');
}

async function autoAcceptBypassPrompt(): Promise<boolean> {
  if (!claudePty) {
    return false;
  }

  if (!looksLikeBypassPrompt(claudePty.recentOutput)) {
    return false;
  }

  claudePty.pty.write('\x1b[B');
  await sleep(120);
  claudePty.pty.write('\r');
  await sleep(320);
  return true;
}

async function waitForClaudeReady(timeoutMs = CLAUDE_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentText = claudePty?.recentOutput ?? '';
    if (looksReadyForInput(currentText)) {
      return;
    }

    if (await autoAcceptBypassPrompt()) {
      continue;
    }

    await sleep(250);
  }

  throw new Error('Claude CLI startup timed out');
}

function startActiveThreadSession(): void {
  const token = ++claudePtyToken;
  const started = startClaudePtySession({
    claudeBin: CLAUDE_BIN,
    cols: terminalSize.cols,
    cwd: activeThreadTarget.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    },
    permissionMode: CLAUDE_PERMISSION_MODE,
    resumeSessionId: activeThreadTarget.resumeSessionId,
    rows: terminalSize.rows,
    onData(chunk) {
      if (token !== claudePtyToken) {
        return;
      }
      handlePtyData(chunk);
    },
    onExit() {
      if (token !== claudePtyToken) {
        return;
      }
      void handlePtyExit();
    }
  });

  claudePty = started.session;
  activeThreadTarget = {
    ...activeThreadTarget,
    resumeSessionId: started.sessionId
  };
  state.sessionId = started.sessionId;
  state.status = 'starting';
  ensureJsonlWatcher(started.sessionId);
  emitSnapshot();
  scheduleJsonlRefresh(0);
}

async function ensureClaudePtySession(): Promise<void> {
  if (claudePty) {
    return;
  }

  clearLastError();
  startActiveThreadSession();
}

async function sendPromptToClaudePty(content: string): Promise<void> {
  if (!claudePty) {
    throw new Error('Claude PTY session is not running');
  }

  const normalizedContent = content.replace(/\r\n/g, '\n');
  if (normalizedContent.includes('\n')) {
    claudePty.pty.write('\x1b[200~');
    claudePty.pty.write(normalizedContent);
    claudePty.pty.write('\x1b[201~');
  } else {
    claudePty.pty.write(normalizedContent);
  }

  await sleep(PROMPT_SUBMIT_DELAY_MS);
  claudePty.pty.write('\r');
}

async function dispatchClaudeMessage(content: string): Promise<void> {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    throw new Error('Message cannot be empty');
  }

  clearLastError();
  if (isActiveStatus(state.status)) {
    throw new Error('Claude is still handling the previous message');
  }
  await ensureClaudePtySession();

  try {
    await waitForClaudeReady();
    awaitingJsonlTurn = true;
    setStatus('running', true);
    await sendPromptToClaudePty(trimmedContent);
    scheduleJsonlRefresh(0);
  } catch (error) {
    setStatus('idle', true);
    setLastError(error instanceof Error ? error.message : 'Claude request failed');
  }
}

async function activateThread(cwd: string, sessionId: string | null): Promise<SelectThreadResultPayload> {
  activeThreadTarget = normalizeThreadTarget(cwd, sessionId);
  const stat = await fs.stat(activeThreadTarget.cwd);
  if (!stat.isDirectory()) {
    throw new Error('Selected project is not a directory');
  }
  closeJsonlWatcher();
  stopActivePty();
  resetRuntimeState(sessionId);
  emitSnapshot();

  if (sessionId) {
    startActiveThreadSession();
  }

  return {
    cwd: activeThreadTarget.cwd,
    label: activeThreadTarget.label,
    sessionId: state.sessionId
  };
}

async function resetConversation(): Promise<void> {
  closeJsonlWatcher();
  stopActivePty();
  activeThreadTarget = {
    ...activeThreadTarget,
    resumeSessionId: null
  };
  resetRuntimeState(null);
  emitSnapshot();
}

async function handleSocketCommand(envelope: CliCommandEnvelope): Promise<CliCommandResult> {
  try {
    if (envelope.name === 'send-message') {
      await dispatchClaudeMessage((envelope.payload as { content: string }).content);
      return { ok: true, payload: null };
    }

    if (envelope.name === 'reset-session') {
      await resetConversation();
      return { ok: true, payload: null };
    }

    if (envelope.name === 'get-runtime-snapshot') {
      await refreshMessagesFromJsonl();
      return {
        ok: true,
        payload: {
          snapshot: createRuntimeSnapshot()
        } satisfies GetRuntimeSnapshotResultPayload
      };
    }

    if (envelope.name === 'get-raw-jsonl') {
      await refreshMessagesFromJsonl();
      return {
        ok: true,
        payload: createRawJsonlResult((envelope.payload as { maxChars?: number }).maxChars)
      };
    }

    if (envelope.name === 'get-older-messages') {
      await refreshMessagesFromJsonl();
      return {
        ok: true,
        payload: createOlderMessagesResult(
          (envelope.payload as { beforeMessageId?: string; maxMessages?: number }).beforeMessageId,
          (envelope.payload as { beforeMessageId?: string; maxMessages?: number }).maxMessages
        )
      };
    }

    if (envelope.name === 'select-thread') {
      const payload = envelope.payload as { cwd: string; sessionId: string | null };
      return {
        ok: true,
        payload: await activateThread(payload.cwd, payload.sessionId ?? null)
      };
    }

    return { ok: false, error: `Unsupported command: ${envelope.name}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CLI command failed';
    setLastError(message);
    return { ok: false, error: message };
  }
}

function connectSocketClient(): void {
  const socket = io(`${SOCKET_URL}/cli`, {
    path: '/socket.io/',
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  });

  socketClient = socket;

  socket.on('connect', () => {
    socket.emit(
      'cli:register',
      {
        cliId: CLI_ID,
        label: activeThreadTarget.label,
        cwd: activeThreadTarget.cwd,
        runtimeBackend: PTY_BACKEND_NAME
      },
      (result: CliRegisterResult) => {
        console.log(`cli registered as ${result.cliId}`);
        emitSnapshot();
      }
    );
  });

  socket.on('cli:command', async (envelope: CliCommandEnvelope, callback?: (result: CliCommandResult) => void) => {
    callback?.(await handleSocketCommand(envelope));
  });

  socket.on('cli:terminal-resize', (payload: { cols: number; rows: number }) => {
    updateTerminalSize(payload.cols, payload.rows);
  });

  socket.on('disconnect', (reason) => {
    console.log(`socket disconnected: ${reason}`);
  });

  socket.on('connect_error', (error) => {
    console.error(`socket connect error: ${error.message}`);
  });
}

async function shutdownCliClient(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    if (shutdownPromise) {
      await shutdownPromise;
    }
    return;
  }

  shuttingDown = true;
  shutdownPromise = (async () => {
    console.log(`shutting down cli client (${reason})`);
    if (jsonlRefreshTimer) {
      clearTimeout(jsonlRefreshTimer);
      jsonlRefreshTimer = null;
    }
    if (snapshotEmitTimer) {
      clearTimeout(snapshotEmitTimer);
      snapshotEmitTimer = null;
    }
    closeJsonlWatcher();
    stopActivePty();
    socketClient?.removeAllListeners();
    socketClient?.disconnect();
    socketClient = null;
  })();

  try {
    await shutdownPromise;
  } finally {
    process.exit(exitCode);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

process.once('SIGINT', () => {
  void shutdownCliClient('SIGINT', 0);
});

process.once('SIGTERM', () => {
  void shutdownCliClient('SIGTERM', 0);
});

process.once('SIGHUP', () => {
  void shutdownCliClient('SIGHUP', 0);
});

export async function startCliClient(): Promise<void> {
  connectSocketClient();
  console.log(`cli client connecting to ${SOCKET_URL} as ${CLI_ID}`);
}
