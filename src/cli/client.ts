import { randomUUID } from 'node:crypto';
import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io, type Socket } from 'socket.io-client';
import type {
  CliCommandEnvelope,
  CliCommandResult,
  CliRegisterResult,
  MessagesUpdatePayload,
  RuntimeSnapshotEnvelope,
  TerminalChunkPayload
} from '../../shared/protocol.ts';
import type { ChatMessage, RuntimeSnapshot } from '../../shared/runtime-types.ts';
import { parseClaudeJsonlState, resolveClaudeJsonlFilePath } from './jsonl.ts';
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
const REPLAY_SNAPSHOT_DEBOUNCE_MS = 250;
const CLAUDE_PERMISSION_MODE = sanitizePermissionMode(process.env.CLAUDE_PERMISSION_MODE);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/claude' : 'claude');
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 32;

let state: RuntimeSnapshot = createFreshState();
let claudePty: ClaudePtySession | null = null;
let socketClient: Socket | null = null;
let snapshotTimer: NodeJS.Timeout | null = null;
let jsonlRefreshTimer: NodeJS.Timeout | null = null;
let jsonlWatcher: FSWatcher | null = null;
let watchedJsonlSessionId: string | null = null;
let replaySnapshotTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

function sanitizePermissionMode(value: string | undefined): string {
  const allowed = new Set(['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']);
  if (value && allowed.has(value)) {
    return value;
  }
  return 'bypassPermissions';
}

function createFreshState(): RuntimeSnapshot {
  return {
    busy: false,
    sessionId: null,
    terminalReplay: '',
    rawJsonl: '',
    messages: [],
    lastError: null
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function emitSnapshot(): void {
  if (!socketClient?.connected) {
    return;
  }

  socketClient.emit('cli:snapshot', {
    snapshot: cloneValue(state)
  } satisfies RuntimeSnapshotEnvelope);
}

function emitMessagesUpdate(): void {
  if (!socketClient?.connected) {
    return;
  }

  socketClient.emit('cli:messages-update', {
    busy: state.busy,
    sessionId: state.sessionId,
    rawJsonl: state.rawJsonl,
    messages: cloneValue(state.messages),
    lastError: state.lastError
  } satisfies MessagesUpdatePayload);
}

function scheduleSnapshot(delayMs = 40): void {
  if (snapshotTimer) {
    return;
  }

  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    emitSnapshot();
  }, delayMs);
}

function scheduleReplaySnapshot(): void {
  if (replaySnapshotTimer) {
    return;
  }

  replaySnapshotTimer = setTimeout(() => {
    replaySnapshotTimer = null;
    emitSnapshot();
  }, REPLAY_SNAPSHOT_DEBOUNCE_MS);
}

function clearLastError(): void {
  if (state.lastError === null) {
    return;
  }
  state.lastError = null;
  emitMessagesUpdate();
  scheduleSnapshot();
}

function setLastError(nextError: string | null): void {
  if (state.lastError === nextError) {
    return;
  }
  state.lastError = nextError;
  emitMessagesUpdate();
  scheduleSnapshot();
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

function syncBusyFromPtyOutput(output: string): void {
  const lifecycle = getClaudePtyLifecycle(output);
  if (lifecycle === 'not_ready') {
    return;
  }

  const nextBusy = lifecycle === 'running';
  if (state.busy === nextBusy) {
    return;
  }

  state.busy = nextBusy;
  emitMessagesUpdate();
  scheduleSnapshot();
}

function messagesEqual(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => {
    const next = right[index];
    return (
      message.id === next.id &&
      message.role === next.role &&
      message.content === next.content &&
      message.status === next.status &&
      message.createdAt === next.createdAt
    );
  });
}

async function refreshMessagesFromJsonl(): Promise<void> {
  const sessionId = state.sessionId;
  if (!sessionId) {
    closeJsonlWatcher();
    if (state.messages.length > 0 || state.busy || state.rawJsonl) {
      state.messages = [];
      state.busy = false;
      state.rawJsonl = '';
      emitMessagesUpdate();
      scheduleSnapshot();
    }
    return;
  }

  ensureJsonlWatcher(sessionId);

  const filePath = resolveSessionJsonlFilePath(sessionId);

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const nextState = parseClaudeJsonlState(raw);
    const messagesChanged = !messagesEqual(state.messages, nextState.messages);
    const rawJsonlChanged = state.rawJsonl !== raw;

    if (messagesChanged) {
      state.messages = nextState.messages;
    }
    if (rawJsonlChanged) {
      state.rawJsonl = raw;
    }

    if (messagesChanged || rawJsonlChanged) {
      emitMessagesUpdate();
      scheduleSnapshot();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (state.rawJsonl) {
        state.rawJsonl = '';
        emitMessagesUpdate();
        scheduleSnapshot();
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

function emitTerminalChunk(data: string): void {
  if (!socketClient?.connected) {
    return;
  }

  socketClient.emit('cli:terminal-chunk', {
    data,
    sessionId: state.sessionId
  } satisfies TerminalChunkPayload);
}

function handlePtyData(chunk: string): void {
  const session = claudePty;
  if (!session) {
    return;
  }

  state.terminalReplay = appendReplayChunk(session, chunk, TERMINAL_REPLAY_MAX_BYTES);
  const recentOutput = appendRecentOutput(session, chunk, RECENT_OUTPUT_MAX_CHARS);
  syncBusyFromPtyOutput(recentOutput);
  emitTerminalChunk(chunk);
  scheduleReplaySnapshot();
  scheduleJsonlRefresh();
}

async function handlePtyExit(): Promise<void> {
  claudePty = null;
  state.busy = false;
  emitMessagesUpdate();
  scheduleSnapshot();
  scheduleJsonlRefresh(0);
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
  ensureJsonlWatcher(started.sessionId);
  emitMessagesUpdate();
  scheduleSnapshot();
  scheduleJsonlRefresh(0);
  scheduleSnapshot();
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
  if (state.busy) {
    throw new Error('Claude is still handling the previous message');
  }

  const trimmedContent = content.trim();
  if (!trimmedContent) {
    throw new Error('Message cannot be empty');
  }

  await ensureClaudePtySession();
  clearLastError();

  try {
    await waitForClaudeReady();
    state.busy = true;
    emitMessagesUpdate();
    scheduleSnapshot();
    await sendPromptToClaudePty(trimmedContent);
    scheduleJsonlRefresh(0);
  } catch (error) {
    state.busy = false;
    emitMessagesUpdate();
    setLastError(error instanceof Error ? error.message : 'Claude request failed');
  }
}

async function resetConversation(): Promise<void> {
  closeJsonlWatcher();
  stopClaudePtySession(claudePty);
  claudePty = null;
  state = createFreshState();
  emitMessagesUpdate();
  scheduleSnapshot();
}

async function handleSocketCommand(envelope: CliCommandEnvelope): Promise<CliCommandResult> {
  try {
    if (envelope.name === 'send-message') {
      await dispatchClaudeMessage(envelope.payload.content);
      return { ok: true };
    }

    if (envelope.name === 'reset-session') {
      await resetConversation();
      return { ok: true };
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
        emitMessagesUpdate();
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
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    if (jsonlRefreshTimer) {
      clearTimeout(jsonlRefreshTimer);
      jsonlRefreshTimer = null;
    }
    closeJsonlWatcher();
    if (replaySnapshotTimer) {
      clearTimeout(replaySnapshotTimer);
      replaySnapshotTimer = null;
    }
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
