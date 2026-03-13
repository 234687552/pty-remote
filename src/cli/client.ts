import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { io, type Socket } from 'socket.io-client';
import type {
  CliCommandEnvelope,
  CliCommandResult,
  CliRegisterResult,
  GetRuntimeSnapshotResultPayload,
  ListProjectSessionsResultPayload,
  PickProjectDirectoryResultPayload,
  RuntimeSnapshotPayload
} from '../../shared/protocol.ts';
import { listProjectSessions } from '../project-history.ts';
import { PtyManager } from './pty-manager.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../..');
const CONFIG_DIR = path.join(os.homedir(), '.pty-remote');
const CLI_ID_FILE = path.join(CONFIG_DIR, 'cli-id');

const SOCKET_URL = process.env.SOCKET_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '3001'}`;
const execFileAsync = promisify(execFile);
const CLI_ID = resolveCliId();
const DEFAULT_CLI_LABEL = resolveDefaultCliLabel();
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
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 32;
const DETACHED_PTY_TTL_MS = 12 * 60 * 60 * 1000;
const DETACHED_DRAFT_TTL_MS = 5 * 60 * 1000;
const DETACHED_JSONL_MISSING_TTL_MS = 2 * 60 * 1000;
const GC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_DETACHED_PTYS = Number.parseInt(process.env.PTY_REMOTE_MAX_DETACHED_PTYS ?? '5', 10);
const CLAUDE_PERMISSION_MODE = sanitizePermissionMode(process.env.CLAUDE_PERMISSION_MODE);

let socketClient: Socket | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

const manager = new PtyManager(
  {
    claudeBin: process.env.CLAUDE_BIN ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/claude' : 'claude'),
    permissionMode: CLAUDE_PERMISSION_MODE,
    defaultCwd: DEFAULT_ROOT_DIR,
    defaultLabel: process.env.PTY_REMOTE_CLI_LABEL?.trim() || DEFAULT_CLI_LABEL,
    terminalCols: TERMINAL_COLS,
    terminalRows: TERMINAL_ROWS,
    terminalReplayMaxBytes: TERMINAL_REPLAY_MAX_BYTES,
    recentOutputMaxChars: RECENT_OUTPUT_MAX_CHARS,
    claudeReadyTimeoutMs: CLAUDE_READY_TIMEOUT_MS,
    promptSubmitDelayMs: PROMPT_SUBMIT_DELAY_MS,
    jsonlRefreshDebounceMs: JSONL_REFRESH_DEBOUNCE_MS,
    snapshotEmitDebounceMs: SNAPSHOT_EMIT_DEBOUNCE_MS,
    snapshotMessagesMax: SNAPSHOT_MESSAGES_MAX,
    olderMessagesPageMax: OLDER_MESSAGES_PAGE_MAX,
    rawJsonlMaxChars: RAW_JSONL_MAX_CHARS,
    gcIntervalMs: GC_INTERVAL_MS,
    detachedDraftTtlMs: DETACHED_DRAFT_TTL_MS,
    detachedJsonlMissingTtlMs: DETACHED_JSONL_MISSING_TTL_MS,
    detachedPtyTtlMs: DETACHED_PTY_TTL_MS,
    maxDetachedPtys: Number.isFinite(MAX_DETACHED_PTYS) && MAX_DETACHED_PTYS > 0 ? MAX_DETACHED_PTYS : 5
  },
  {
    emitMessagesUpsert(payload) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:messages-upsert', {
        ...payload,
        cliId: CLI_ID
      });
    },
    emitSnapshot(snapshot) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:snapshot', {
        cliId: CLI_ID,
        snapshot
      } satisfies RuntimeSnapshotPayload);
    },
    emitTerminalChunk(payload) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:terminal-chunk', {
        ...payload,
        cliId: CLI_ID
      });
    }
  }
);

function sanitizeIdentifier(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveCliId(): string {
  const explicit = process.env.PTY_REMOTE_CLI_ID?.trim();
  if (explicit) {
    return sanitizeIdentifier(explicit);
  }

  try {
    const persisted = readFileSync(CLI_ID_FILE, 'utf8').trim();
    if (persisted) {
      return sanitizeIdentifier(persisted);
    }
  } catch {
    // Fall back to generating a local persistent id.
  }

  const generated = sanitizeIdentifier(`cli-${randomUUID()}`);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CLI_ID_FILE, `${generated}\n`, 'utf8');
  return generated;
}

function resolveDefaultCliLabel(): string {
  if (process.platform === 'darwin') {
    try {
      const computerName = execFileSyncSafe('scutil', ['--get', 'ComputerName']);
      if (computerName) {
        return computerName;
      }
    } catch {
      // Fall back to hostname.
    }
  }

  return os.hostname() || path.basename(DEFAULT_ROOT_DIR) || 'claude-cli';
}

function execFileSyncSafe(command: string, args: string[]): string {
  return `${execFileSync(command, args, { encoding: 'utf8' })}`.trim();
}

function sanitizePermissionMode(value: string | undefined): string {
  const allowed = new Set(['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']);
  if (value && allowed.has(value)) {
    return value;
  }
  return 'bypassPermissions';
}

async function handleSocketCommand(envelope: CliCommandEnvelope): Promise<CliCommandResult> {
  try {
    if (envelope.name === 'send-message') {
      await manager.dispatchMessage((envelope.payload as { content: string }).content);
      return { ok: true, payload: null };
    }

    if (envelope.name === 'stop-message') {
      await manager.stopActiveRun();
      return { ok: true, payload: null };
    }

    if (envelope.name === 'reset-session') {
      await manager.resetActiveThread();
      return { ok: true, payload: null };
    }

    if (envelope.name === 'get-runtime-snapshot') {
      await manager.replayActiveState();
      return {
        ok: true,
        payload: {
          snapshot: manager.getSnapshot()
        } satisfies GetRuntimeSnapshotResultPayload
      };
    }

    if (envelope.name === 'get-raw-jsonl') {
      return {
        ok: true,
        payload: await manager.getRawJsonl((envelope.payload as { maxChars?: number }).maxChars)
      };
    }

    if (envelope.name === 'get-older-messages') {
      const payload = envelope.payload as { beforeMessageId?: string; maxMessages?: number };
      return {
        ok: true,
        payload: await manager.getOlderMessages(payload.beforeMessageId, payload.maxMessages)
      };
    }

    if (envelope.name === 'select-thread') {
      const payload = envelope.payload as { cwd: string; label?: string; sessionId: string | null; threadKey: string };
      return {
        ok: true,
        payload: await manager.activateThread({
          cwd: payload.cwd,
          label: payload.label?.trim() || path.basename(payload.cwd) || payload.cwd,
          sessionId: payload.sessionId ?? null,
          threadKey: payload.threadKey
        })
      };
    }

    if (envelope.name === 'list-project-sessions') {
      const payload = envelope.payload as { cwd: string; maxSessions?: number };
      return {
        ok: true,
        payload: {
          cwd: payload.cwd,
          label: path.basename(payload.cwd) || payload.cwd,
          sessions: await listProjectSessions(payload.cwd, payload.maxSessions)
        } satisfies ListProjectSessionsResultPayload
      };
    }

    if (envelope.name === 'pick-project-directory') {
      return {
        ok: true,
        payload: await pickProjectDirectory()
      };
    }

    return { ok: false, error: `Unsupported command: ${envelope.name}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'CLI command failed'
    };
  }
}

async function pickProjectDirectory(): Promise<PickProjectDirectoryResultPayload> {
  if (process.platform === 'darwin') {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Select a project directory")'
      ]));
    } catch (error) {
      const commandError = error as NodeJS.ErrnoException & { stderr?: string };
      const stderr = `${commandError.stderr ?? ''}`.trim();
      if (stderr.includes('用户已取消') || stderr.includes('User canceled') || stderr.includes('(-128)')) {
        throw new Error('已取消选择目录');
      }
      throw error;
    }

    const cwd = stdout.trim().replace(/\/+$/, '') || '/';
    return {
      cwd,
      label: path.basename(cwd) || cwd
    };
  }

  throw new Error(`Directory picker is not implemented for ${process.platform}`);
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
    const registration = manager.getRegistrationPayload();
    socket.emit(
      'cli:register',
      {
        cliId: CLI_ID,
        label: registration.label,
        cwd: registration.cwd,
        threadKey: registration.threadKey,
        sessionId: registration.sessionId,
        runtimeBackend: PTY_BACKEND_NAME
      },
      (result: CliRegisterResult) => {
        if (!result.ok) {
          const message = result.error || `CLI ${CLI_ID} registration was rejected`;
          console.error(message);
          void shutdownCliClient(message, 1);
          return;
        }

        console.log(`cli registered as ${result.cliId}`);
        void manager.replayActiveState();
      }
    );
  });

  socket.on('cli:command', async (envelope: CliCommandEnvelope, callback?: (result: CliCommandResult) => void) => {
    callback?.(await handleSocketCommand(envelope));
  });

  socket.on('cli:terminal-resize', (payload: { cols: number; rows: number }) => {
    manager.updateTerminalSize(payload.cols, payload.rows);
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
    await manager.shutdown();
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
