import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { io, type Socket } from 'socket.io-client';
import type {
  CliCommandEnvelope,
  CliCommandResult,
  CliRegisterPayload,
  CliRegisterResult,
  GitDiffFileResultPayload,
  ListDirectoryResultPayload,
  ListGitStatusFilesResultPayload,
  ListSlashCommandsResultPayload,
  ListManagedPtyHandlesResultPayload,
  ListProjectSessionsResultPayload,
  PickProjectDirectoryResultPayload,
  ReadProjectFileResultPayload,
  RuntimeMetaPayload,
  UploadAttachmentResultPayload,
  TerminalFramePatchPayload,
  TerminalInputPayload,
  TerminalSessionEvictedPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId, RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import { AttachmentManager } from '../attachments/manager.ts';
import { createClaudeProviderRuntime } from '../providers/claude.ts';
import { createCodexProviderRuntime, type CodexProviderRuntimeOptions } from '../providers/codex.ts';
import type { ProviderRuntime } from '../providers/provider-runtime.ts';
import { normalizeProcessShellEnv } from '../providers/shell-exec.ts';
import { getGitDiffFile, listDirectory, listGitStatusFiles, readProjectFile, resolveProjectRoot } from './file-browser.ts';
import { loadCliConfig } from './cli-config.ts';
import type { PtyManagerOptions } from './pty-manager.ts';

const DEFAULT_ROOT_DIR = path.resolve(process.cwd());
const CONFIG_DIR = path.join(os.homedir(), '.pty-remote');
const CLI_ID_FILE = path.join(CONFIG_DIR, 'cli-id');
const ALL_PROVIDERS: ProviderId[] = ['claude', 'codex'];

const cliConfig = loadCliConfig();

function getConfigValue(key: string): string | undefined {
  const envValue = process.env[key];
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  const configValue = cliConfig[key];
  if (typeof configValue === 'string' && configValue.trim()) {
    return configValue.trim();
  }
  return undefined;
}

function getConfigInt(key: string, fallback: number, min = 0): number {
  const raw = getConfigValue(key);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

const configCodexHome = getConfigValue('CODEX_HOME');
if (configCodexHome && !process.env.CODEX_HOME) {
  process.env.CODEX_HOME = configCodexHome;
}

const SOCKET_URL =
  getConfigValue('SOCKET_URL') ?? `http://${getConfigValue('HOST') ?? '127.0.0.1'}:${getConfigValue('PORT') ?? '3001'}`;
const execFileAsync = promisify(execFile);
const SUPPORTED_PROVIDERS = resolveSupportedProviders(resolveProvidersConfigValue());
const CLI_ID = resolveCliId();
const CLI_LABEL = resolveCliLabel();
const PTY_BACKEND_NAME = 'node-pty';
const TERMINAL_FRAME_SCROLLBACK = getConfigInt('TERMINAL_FRAME_SCROLLBACK', 500, 50);
const RECENT_OUTPUT_MAX_CHARS = getConfigInt('RECENT_OUTPUT_MAX_CHARS', 12_000, 1);
const CLAUDE_READY_TIMEOUT_MS = getConfigInt('CLAUDE_READY_TIMEOUT_MS', 20_000, 0);
const CODEX_READY_TIMEOUT_MS = getConfigInt('CODEX_READY_TIMEOUT_MS', 20_000, 0);
const PROMPT_SUBMIT_DELAY_MS = getConfigInt('PROMPT_SUBMIT_DELAY_MS', 120, 0);
const JSONL_REFRESH_DEBOUNCE_MS = getConfigInt('JSONL_REFRESH_DEBOUNCE_MS', 120, 0);
const SNAPSHOT_MESSAGES_MAX = getConfigInt('SNAPSHOT_MESSAGES_MAX', 40, 1);
const TERMINAL_COLS = getConfigInt('TERMINAL_COLS', 120, 1);
const TERMINAL_ROWS = getConfigInt('TERMINAL_ROWS', 32, 1);
const DETACHED_PTY_TTL_MS = getConfigInt('DETACHED_PTY_TTL_MS', 12 * 60 * 60 * 1000, 0);
const DETACHED_DRAFT_TTL_MS = getConfigInt('DETACHED_DRAFT_TTL_MS', 5 * 60 * 1000, 0);
const DETACHED_JSONL_MISSING_TTL_MS = getConfigInt('DETACHED_JSONL_MISSING_TTL_MS', 2 * 60 * 1000, 0);
const GC_INTERVAL_MS = getConfigInt('GC_INTERVAL_MS', 5 * 60 * 1000, 0);
const MAX_DETACHED_PTYS = getConfigInt('PTY_REMOTE_MAX_DETACHED_PTYS', 5, 1);
const CLAUDE_PERMISSION_MODE = sanitizePermissionMode(getConfigValue('CLAUDE_PERMISSION_MODE'));

let socketClient: Socket | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
const attachmentManager = new AttachmentManager();

const runtimeOptions: PtyManagerOptions = {
  permissionMode: CLAUDE_PERMISSION_MODE,
  defaultCwd: DEFAULT_ROOT_DIR,
  terminalCols: TERMINAL_COLS,
  terminalRows: TERMINAL_ROWS,
  terminalFrameScrollback: TERMINAL_FRAME_SCROLLBACK,
  recentOutputMaxChars: RECENT_OUTPUT_MAX_CHARS,
  claudeReadyTimeoutMs: CLAUDE_READY_TIMEOUT_MS,
  promptSubmitDelayMs: PROMPT_SUBMIT_DELAY_MS,
  jsonlRefreshDebounceMs: JSONL_REFRESH_DEBOUNCE_MS,
  snapshotMessagesMax: SNAPSHOT_MESSAGES_MAX,
  gcIntervalMs: GC_INTERVAL_MS,
  detachedDraftTtlMs: DETACHED_DRAFT_TTL_MS,
  detachedJsonlMissingTtlMs: DETACHED_JSONL_MISSING_TTL_MS,
  detachedPtyTtlMs: DETACHED_PTY_TTL_MS,
  maxDetachedPtys: MAX_DETACHED_PTYS
};

const codexRuntimeOptions: CodexProviderRuntimeOptions = {
  defaultCwd: DEFAULT_ROOT_DIR,
  terminalCols: TERMINAL_COLS,
  terminalRows: TERMINAL_ROWS,
  terminalFrameScrollback: TERMINAL_FRAME_SCROLLBACK,
  recentOutputMaxChars: RECENT_OUTPUT_MAX_CHARS,
  codexReadyTimeoutMs: CODEX_READY_TIMEOUT_MS,
  promptSubmitDelayMs: PROMPT_SUBMIT_DELAY_MS,
  jsonlRefreshDebounceMs: JSONL_REFRESH_DEBOUNCE_MS,
  snapshotMessagesMax: SNAPSHOT_MESSAGES_MAX,
  gcIntervalMs: GC_INTERVAL_MS,
  detachedDraftTtlMs: DETACHED_DRAFT_TTL_MS,
  detachedJsonlMissingTtlMs: DETACHED_JSONL_MISSING_TTL_MS,
  detachedPtyTtlMs: DETACHED_PTY_TTL_MS,
  maxDetachedPtys: MAX_DETACHED_PTYS,
  historyPath: getConfigValue('CODEX_HISTORY_PATH')?.trim() || undefined,
  sessionsRootPath: getConfigValue('CODEX_SESSIONS_ROOT_PATH')?.trim() || undefined
};

function cliErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function logCli(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
  const logger = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
  if (details) {
    logger(`[pty-remote][cli] ${message}`, details);
    return;
  }
  logger(`[pty-remote][cli] ${message}`);
}

function createRuntime(providerId: ProviderId): ProviderRuntime {
  const callbacks = {
    emitMessagesUpsert(payload: {
      providerId: ProviderId | null;
      conversationKey: string | null;
      sessionId: string | null;
      upserts: RuntimeSnapshot['messages'];
      recentMessageIds: string[];
      hasOlderMessages: boolean;
    }) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:messages-upsert', {
        ...payload,
        cliId: CLI_ID
      });
    },
    emitRuntimeMeta(payload: Omit<RuntimeMetaPayload, 'cliId'>) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:runtime-meta', {
        ...payload,
        cliId: CLI_ID
      } satisfies RuntimeMetaPayload);
    },
    emitTerminalFramePatch(payload: { conversationKey: string | null; patch: TerminalFramePatchPayload['patch'] }) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:terminal-frame-patch', {
        ...payload,
        cliId: CLI_ID,
        providerId
      } satisfies TerminalFramePatchPayload);
    },
    emitTerminalSessionEvicted(payload: { conversationKey: string | null; reason: string; sessionId: string }) {
      if (!socketClient?.connected) {
        return;
      }
      socketClient.emit('cli:terminal-session-evicted', {
        ...payload,
        cliId: CLI_ID,
        providerId
      } satisfies TerminalSessionEvictedPayload);
    }
  };

  if (providerId === 'codex') {
    return createCodexProviderRuntime(codexRuntimeOptions, callbacks);
  }

  return createClaudeProviderRuntime(runtimeOptions, callbacks);
}

const runtimes = Object.fromEntries(
  SUPPORTED_PROVIDERS.map((providerId) => [providerId, createRuntime(providerId)])
) as Record<ProviderId, ProviderRuntime>;

function sanitizeIdentifier(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveCliId(): string {
  const explicit = getConfigValue('PTY_REMOTE_CLI_ID');
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

function resolveCliLabel(): string {
  const envMachineName = process.env.COMPUTERNAME?.trim() || process.env.HOSTNAME?.trim();
  if (envMachineName) {
    return envMachineName;
  }

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

  return os.hostname() || path.basename(DEFAULT_ROOT_DIR) || 'pty-remote-cli';
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

function resolveProvidersConfigValue(): string | undefined {
  const envProviders = process.env.PTY_REMOTE_PROVIDERS?.trim();
  if (envProviders) {
    return envProviders;
  }

  const envProvider = process.env.PTY_REMOTE_PROVIDER?.trim();
  if (envProvider) {
    return envProvider;
  }

  const configProviders = cliConfig.PTY_REMOTE_PROVIDERS?.trim();
  if (configProviders) {
    return configProviders;
  }

  const configProvider = cliConfig.PTY_REMOTE_PROVIDER?.trim();
  if (configProvider) {
    return configProvider;
  }

  return undefined;
}

function resolveSupportedProviders(value: string | undefined): ProviderId[] {
  const normalizedProviders = (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const providers = ALL_PROVIDERS.filter((providerId) => normalizedProviders.includes(providerId));
  return providers.length > 0 ? providers : [...ALL_PROVIDERS];
}

function getRuntime(providerId: ProviderId): ProviderRuntime {
  const runtime = runtimes[providerId];
  if (!runtime) {
    throw new Error(`Provider ${providerId} is not enabled on this CLI`);
  }
  return runtime;
}

function requireTargetProviderId(envelope: CliCommandEnvelope): ProviderId {
  const providerId = envelope.targetProviderId ?? null;
  if (!providerId) {
    throw new Error('Provider is not selected');
  }
  return providerId;
}

async function handleSocketCommand(envelope: CliCommandEnvelope): Promise<CliCommandResult> {
  try {
    if (envelope.name === 'send-message') {
      const content = (envelope.payload as { content: string }).content;
      await getRuntime(requireTargetProviderId(envelope)).dispatchMessage(content);
      attachmentManager.markReferencedPathsAsSent(content);
      return { ok: true, payload: null };
    }

    if (envelope.name === 'list-slash-commands') {
      const runtime = getRuntime(requireTargetProviderId(envelope));
      return {
        ok: true,
        payload: {
          providerId: runtime.providerId,
          commands: await runtime.listSlashCommands()
        } satisfies ListSlashCommandsResultPayload
      };
    }

    if (envelope.name === 'list-directory') {
      const payload = envelope.payload as { cwd: string; path?: string };
      const cwd = await resolveProjectRoot(payload.cwd);
      return {
        ok: true,
        payload: await listDirectory(cwd, payload.path ?? '') satisfies ListDirectoryResultPayload
      };
    }

    if (envelope.name === 'list-git-status-files') {
      const payload = envelope.payload as { cwd: string };
      const cwd = await resolveProjectRoot(payload.cwd);
      return {
        ok: true,
        payload: await listGitStatusFiles(cwd) satisfies ListGitStatusFilesResultPayload
      };
    }

    if (envelope.name === 'read-project-file') {
      const payload = envelope.payload as { cwd: string; maxBytes?: number; path: string };
      const cwd = await resolveProjectRoot(payload.cwd);
      return {
        ok: true,
        payload: await readProjectFile(cwd, payload.path, payload.maxBytes) satisfies ReadProjectFileResultPayload
      };
    }

    if (envelope.name === 'git-diff-file') {
      const payload = envelope.payload as { cwd: string; path: string; staged?: boolean };
      const cwd = await resolveProjectRoot(payload.cwd);
      return {
        ok: true,
        payload: await getGitDiffFile(cwd, payload.path, payload.staged ?? false) satisfies GitDiffFileResultPayload
      };
    }

    if (envelope.name === 'upload-attachment') {
      const providerId = requireTargetProviderId(envelope);
      const payload = envelope.payload as {
        contentBase64: string;
        conversationKey: string | null;
        cwd: string;
        filename: string;
        mimeType: string;
        sessionId: string | null;
        size: number;
      };
      const attachment = await attachmentManager.uploadAttachment({
        contentBase64: payload.contentBase64,
        conversationKey: payload.conversationKey,
        cwd: payload.cwd,
        filename: payload.filename,
        mimeType: payload.mimeType,
        providerId,
        sessionId: payload.sessionId,
        size: payload.size
      });

      return {
        ok: true,
        payload: {
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          path: attachment.path,
          size: attachment.size
        } satisfies UploadAttachmentResultPayload
      };
    }

    if (envelope.name === 'delete-attachment') {
      const payload = envelope.payload as { attachmentId: string };
      await attachmentManager.deleteAttachment(payload.attachmentId);
      return { ok: true, payload: null };
    }

    if (envelope.name === 'stop-message') {
      await getRuntime(requireTargetProviderId(envelope)).stopActiveRun();
      return { ok: true, payload: null };
    }

    if (envelope.name === 'reset-session') {
      await getRuntime(requireTargetProviderId(envelope)).resetActiveConversation();
      return { ok: true, payload: null };
    }

    if (envelope.name === 'select-conversation') {
      const payload = envelope.payload as {
        cwd: string;
        label?: string;
        sessionId: string | null;
        conversationKey: string;
        clientRequestId?: string | null;
      };
      const runtime = getRuntime(requireTargetProviderId(envelope));
      return {
        ok: true,
        payload: {
          ...(await runtime.activateConversation({
            cwd: payload.cwd,
            label: payload.label?.trim() || path.basename(payload.cwd) || payload.cwd,
            sessionId: payload.sessionId ?? null,
            conversationKey: payload.conversationKey
          })),
          clientRequestId: payload.clientRequestId ?? null
        }
      };
    }

    if (envelope.name === 'cleanup-project') {
      const payload = envelope.payload as { cwd: string };
      const providerId = requireTargetProviderId(envelope);
      const runtime = getRuntime(providerId);
      await runtime.cleanupProject(payload.cwd);
      await attachmentManager.cleanupProject({
        cwd: payload.cwd,
        providerId
      });
      return { ok: true, payload: null };
    }

    if (envelope.name === 'cleanup-conversation') {
      const payload = envelope.payload as {
        cwd: string;
        conversationKey: string;
        sessionId: string | null;
      };
      const providerId = requireTargetProviderId(envelope);
      const runtime = getRuntime(providerId);
      await runtime.cleanupConversation({
        cwd: payload.cwd,
        conversationKey: payload.conversationKey,
        sessionId: payload.sessionId ?? null
      });
      await attachmentManager.cleanupConversation({
        conversationKey: payload.conversationKey,
        cwd: payload.cwd,
        providerId,
        sessionId: payload.sessionId ?? null
      });
      return { ok: true, payload: null };
    }

    if (envelope.name === 'list-project-conversations') {
      const payload = envelope.payload as { cwd: string; maxSessions?: number };
      const runtime = getRuntime(requireTargetProviderId(envelope));
      const cwd = await resolveProjectRoot(payload.cwd);
      return {
        ok: true,
        payload: {
          providerId: runtime.providerId,
          cwd,
          label: path.basename(cwd) || cwd,
          sessions: await runtime.listProjectConversations(cwd, payload.maxSessions)
        } satisfies ListProjectSessionsResultPayload
      };
    }

    if (envelope.name === 'list-managed-pty-handles') {
      const runtime = getRuntime(requireTargetProviderId(envelope));
      return {
        ok: true,
        payload: {
          providerId: runtime.providerId,
          handles: await runtime.listManagedPtyHandles()
        } satisfies ListManagedPtyHandlesResultPayload
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
    logCli('error', 'socket command failed', {
      command: envelope.name,
      error: cliErrorMessage(error, 'CLI command failed'),
      requestId: envelope.requestId,
      targetProviderId: envelope.targetProviderId ?? null
    });
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

    const cwd = await resolveProjectRoot(stdout.trim().replace(/\/+$/, '') || '/');
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
    const registrations = Object.fromEntries(
      SUPPORTED_PROVIDERS.map((providerId) => [providerId, getRuntime(providerId).getRegistrationPayload()])
    ) as CliRegisterPayload['runtimes'];
    const primaryRegistration = registrations[SUPPORTED_PROVIDERS[0]];
    socket.emit(
      'cli:register',
      {
        cliId: CLI_ID,
        label: CLI_LABEL,
        cwd: primaryRegistration?.cwd ?? DEFAULT_ROOT_DIR,
        supportedProviders: SUPPORTED_PROVIDERS,
        runtimes: registrations,
        runtimeBackend: PTY_BACKEND_NAME
      } satisfies CliRegisterPayload,
      (result: CliRegisterResult) => {
        if (!result.ok) {
          if (result.errorCode === 'conflict') {
            socket.io.opts.reconnection = false;
          }
          const message = result.error || `CLI ${CLI_ID} registration was rejected`;
          console.error(message);
          void shutdownCliClient(message, 1);
          return;
        }

        console.log(`cli registered as ${result.cliId}`);
      }
    );
  });

  socket.on('cli:command', async (envelope: CliCommandEnvelope, callback?: (result: CliCommandResult) => void) => {
    callback?.(await handleSocketCommand(envelope));
  });

  socket.on('cli:terminal-resize', (payload: { cols: number; rows: number; targetProviderId?: ProviderId | null }) => {
    const providerId = payload.targetProviderId ?? null;
    if (!providerId) {
      return;
    }
    getRuntime(providerId).updateTerminalSize(payload.cols, payload.rows);
  });

  socket.on(
    'cli:terminal-input',
    async (payload: Omit<TerminalInputPayload, 'targetCliId'>, callback?: (result: { ok: boolean; error?: string }) => void) => {
      try {
        const providerId = payload.targetProviderId ?? null;
        if (!providerId) {
          throw new Error('Provider is not selected');
        }
        await getRuntime(providerId).sendTerminalInput(payload.input);
        callback?.({ ok: true });
      } catch (error) {
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to send terminal input'
        });
      }
    }
  );

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
    await Promise.all(SUPPORTED_PROVIDERS.map((providerId) => getRuntime(providerId).shutdown()));
    await attachmentManager.shutdown();
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
  const originalShell = process.env.SHELL?.trim() || null;
  const normalizedShell = normalizeProcessShellEnv(process.env);
  if (normalizedShell !== originalShell) {
    console.log('[pty-remote][cli] normalized SHELL', {
      normalizedShell,
      originalShell
    });
  }
  attachmentManager.start();
  connectSocketClient();
  console.log(`cli client connecting to ${SOCKET_URL} as ${CLI_ID}`);
}
