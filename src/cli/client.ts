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
  CliRegisterResult,
  MessagesUpsertPayload,
  RuntimeSnapshotPayload,
  TerminalChunkPayload
} from '../../shared/protocol.ts';
import type { ChatMessage, RuntimeSnapshot, RuntimeStatus } from '../../shared/runtime-types.ts';
import {
  applyClaudeJsonlLine,
  createClaudeJsonlMessagesState,
  materializeClaudeJsonlMessages,
  resolveClaudeJsonlFilePath,
  type ClaudeJsonlMessagesState
} from './jsonl.ts';
import {
  appendRecentOutput,
  appendReplayChunk,
  type ClaudePtySession,
  getClaudePtyLifecycle,
  looksLikeBypassPrompt,
  looksReadyForInput,
  startClaudePtySession,
  stopClaudePtySession
} from './pty.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const SOCKET_URL = process.env.SOCKET_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '3001'}`;
const CLI_ID = (process.env.HAPI_TMUX_CLI_ID ?? `${path.basename(ROOT_DIR)}-${randomUUID().slice(0, 8)}`)
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, '-');
const CLI_LABEL = (process.env.HAPI_TMUX_CLI_LABEL ?? path.basename(ROOT_DIR) ?? 'claude-cli').trim();
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

let state: AgentRuntimeState = createFreshState();
let claudePty: ClaudePtySession | null = null;
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

function resolveRuntimeStatusFromPtyOutput(output: string): RuntimeStatus {
  const lifecycle = getClaudePtyLifecycle(output);
  if (lifecycle === 'running') {
    return 'running';
  }
  if (lifecycle === 'idle') {
    return 'idle';
  }
  return 'starting';
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
    state.status = claudePty ? resolveRuntimeStatusFromPtyOutput(claudePty.recentOutput) : 'idle';
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
  return resolveClaudeJsonlFilePath(ROOT_DIR, sessionId, os.homedir());
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

function syncStatusFromPtyOutput(output: string): void {
  setStatus(resolveRuntimeStatusFromPtyOutput(output));
}

function applyStreamingStatus(messages: ChatMessage[], status: RuntimeStatus): ChatMessage[] {
  if (status !== 'running') {
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
  hasOlderMessages: boolean
): MessagesUpsertPayload | null {
  const previousIds = previousMessages.map((message) => message.id);
  const nextIds = nextMessages.map((message) => message.id);
  const idsChanged =
    previousIds.length !== nextIds.length || previousIds.some((messageId, index) => messageId !== nextIds[index]);

  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  const upserts = nextMessages.filter((message) => !messageEqual(previousById.get(message.id), message));

  if (!idsChanged && upserts.length === 0) {
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

    const nextAllMessages = applyStreamingStatus(materializeClaudeJsonlMessages(jsonlMessagesState), state.status);
    const nextMessages = selectRecentMessages(nextAllMessages);
    const allMessagesChanged = !messagesEqual(state.allMessages, nextAllMessages);
    const messagesChanged = !messagesEqual(state.messages, nextMessages);
    const hasOlderMessagesChanged = state.hasOlderMessages !== (nextAllMessages.length > nextMessages.length);

    if (allMessagesChanged) {
      state.allMessages = nextAllMessages;
    }
    if (messagesChanged) {
      state.messages = nextMessages;
    }
    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
      state.hasOlderMessages = nextAllMessages.length > nextMessages.length;
    }

    if (allMessagesChanged || messagesChanged || hasOlderMessagesChanged) {
      const upsertPayload = createMessagesUpsertPayload(
        previousMessages,
        nextMessages,
        sessionId,
        nextAllMessages.length > nextMessages.length
      );
      if (upsertPayload) {
        emitMessagesUpsert(upsertPayload);
      }
      scheduleSnapshotEmit(0);
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
  const recentOutput = appendRecentOutput(session, chunk, RECENT_OUTPUT_MAX_CHARS);
  syncStatusFromPtyOutput(recentOutput);
  emitTerminalChunk(chunk, chunkOffset);
  scheduleJsonlRefresh();
}

async function handlePtyExit(): Promise<void> {
  const expectedExit = suppressNextPtyExitError;
  suppressNextPtyExitError = false;
  claudePty = null;
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

async function ensureClaudePtySession(): Promise<void> {
  if (claudePty) {
    return;
  }

  clearLastError();
  stopClaudePtySession(claudePty);
  claudePty = null;

  const hadPreviousContext = state.messages.length > 0 || state.sessionId !== null || state.terminalReplay.length > 0;
  if (hadPreviousContext) {
    state = createFreshState();
  }

  const started = startClaudePtySession({
    claudeBin: CLAUDE_BIN,
    cols: TERMINAL_COLS,
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    },
    permissionMode: CLAUDE_PERMISSION_MODE,
    rows: TERMINAL_ROWS,
    onData(chunk) {
      handlePtyData(chunk);
    },
    onExit() {
      void handlePtyExit();
    }
  });

  claudePty = started.session;
  state.sessionId = started.sessionId;
  state.status = 'starting';
  ensureJsonlWatcher(started.sessionId);
  emitSnapshot();
  scheduleJsonlRefresh(0);
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
    setStatus('running', true);
    await sendPromptToClaudePty(trimmedContent);
    scheduleJsonlRefresh(0);
  } catch (error) {
    setStatus('idle', true);
    setLastError(error instanceof Error ? error.message : 'Claude request failed');
  }
}

async function resetConversation(): Promise<void> {
  closeJsonlWatcher();
  suppressNextPtyExitError = true;
  stopClaudePtySession(claudePty);
  claudePty = null;
  state = createFreshState();
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
        label: CLI_LABEL,
        cwd: ROOT_DIR,
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
    suppressNextPtyExitError = true;
    stopClaudePtySession(claudePty);
    claudePty = null;
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
