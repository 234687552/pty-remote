import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server as SocketIOServer, type Socket } from 'socket.io';
import type {
  CliCommandEnvelope,
  CliCommandResult,
  CliRegisterPayload,
  CliRegisterResult,
  CliStatusPayload,
  MessagesUpsertPayload,
  RuntimeSnapshotPayload,
  TerminalChunkPayload,
  TerminalResumeRequestPayload,
  TerminalResumeResultPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '../../shared/protocol.ts';
import type { CliDescriptor, RuntimeSnapshot } from '../../shared/runtime-types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const WEB_BUILD_DIR = path.join(PUBLIC_DIR, 'build');
const WEB_BUILD_INDEX_FILE = path.join(WEB_BUILD_DIR, 'index.html');

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const TERMINAL_REPLAY_MAX_BYTES = 256 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

interface CliRuntimeRecord {
  socket: Socket;
  descriptor: CliDescriptor;
  snapshot: RuntimeSnapshot | null;
  terminalReplay: string;
  terminalReplayOffset: number;
  terminalReplaySessionId: string | null;
}

let cliRecord: CliRuntimeRecord | null = null;
let httpServer: http.Server | null = null;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function json(res: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

async function serveStaticFile(res: ServerResponse<IncomingMessage>, filePath: string): Promise<void> {
  const extension = path.extname(filePath);
  const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

async function serveWebApp(res: ServerResponse<IncomingMessage>): Promise<void> {
  try {
    await serveStaticFile(res, WEB_BUILD_INDEX_FILE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
    json(res, 503, {
      error: 'Web UI build is not ready. Run `npm run build:web` or wait for `npm run dev:web` to finish.'
    });
  }
}

function resolvePublicAssetPath(urlPathname: string): string | null {
  const normalizedPath = path.posix.normalize(urlPathname);
  if (!normalizedPath.startsWith('/') || normalizedPath.includes('\0')) {
    return null;
  }

  const relativePath = normalizedPath.replace(/^\/+/, '');
  if (!relativePath) {
    return null;
  }

  const resolvedPath = path.resolve(PUBLIC_DIR, relativePath);
  if (resolvedPath !== PUBLIC_DIR && !resolvedPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

function createCliDescriptor(cliId: string, payload: CliRegisterPayload): CliDescriptor {
  const now = new Date().toISOString();
  return {
    cliId,
    label: payload.label?.trim() || path.basename(payload.cwd) || cliId,
    cwd: payload.cwd,
    runtimeBackend: payload.runtimeBackend,
    connected: true,
    status: 'idle',
    sessionId: null,
    connectedAt: now,
    lastSeenAt: now
  };
}

function updateDescriptorFromSnapshot(record: CliRuntimeRecord): void {
  if (!record.snapshot) {
    return;
  }

  record.descriptor = {
    ...record.descriptor,
    status: record.snapshot.status,
    sessionId: record.snapshot.sessionId,
    lastSeenAt: new Date().toISOString()
  };
}

function ensureSnapshot(record: CliRuntimeRecord): RuntimeSnapshot {
  if (!record.snapshot) {
    record.snapshot = {
      status: record.descriptor.status,
      sessionId: record.descriptor.sessionId,
      messages: [],
      hasOlderMessages: false,
      lastError: null
    };
  }

  return record.snapshot;
}

function clearTerminalReplay(record: CliRuntimeRecord, sessionId: string | null): void {
  record.terminalReplay = '';
  record.terminalReplayOffset = 0;
  record.terminalReplaySessionId = sessionId;
}

function trimTerminalReplay(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= TERMINAL_REPLAY_MAX_BYTES) {
    return value;
  }
  return buffer.subarray(buffer.length - TERMINAL_REPLAY_MAX_BYTES).toString('utf8');
}

function syncTerminalReplaySession(record: CliRuntimeRecord, sessionId: string | null): void {
  if (record.terminalReplaySessionId === sessionId) {
    return;
  }
  clearTerminalReplay(record, sessionId);
}

function applyMessagesUpsert(record: CliRuntimeRecord, payload: MessagesUpsertPayload): void {
  const snapshot = ensureSnapshot(record);
  if (snapshot.sessionId !== payload.sessionId) {
    snapshot.sessionId = payload.sessionId;
    snapshot.messages = [];
  }

  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  for (const message of payload.upserts) {
    messagesById.set(message.id, cloneValue(message));
  }

  snapshot.messages = payload.recentMessageIds
    .map((messageId) => messagesById.get(messageId))
    .filter(Boolean) as RuntimeSnapshot['messages'];
  snapshot.hasOlderMessages = payload.hasOlderMessages;
}

function appendTerminalReplay(record: CliRuntimeRecord, chunk: string): void {
  const nextReplay = `${record.terminalReplay}${chunk}`;
  const trimmedReplay = trimTerminalReplay(nextReplay);
  const removedBytes = Buffer.byteLength(nextReplay, 'utf8') - Buffer.byteLength(trimmedReplay, 'utf8');
  record.terminalReplay = trimmedReplay;
  record.terminalReplayOffset += removedBytes;
}

function getTerminalReplayEndOffset(record: CliRuntimeRecord): number {
  return record.terminalReplayOffset + Buffer.byteLength(record.terminalReplay, 'utf8');
}

function getTerminalSessionId(record: CliRuntimeRecord | null): string | null {
  return record?.terminalReplaySessionId ?? record?.snapshot?.sessionId ?? null;
}

function createTerminalResumeResult(payload: TerminalResumeRequestPayload): TerminalResumeResultPayload {
  const sessionId = getTerminalSessionId(cliRecord);
  if (!cliRecord || !sessionId) {
    return {
      mode: 'reset',
      sessionId: null,
      offset: 0,
      data: ''
    };
  }

  const replayStartOffset = cliRecord.terminalReplayOffset;
  const replayEndOffset = getTerminalReplayEndOffset(cliRecord);

  if (payload.sessionId === sessionId && payload.lastOffset >= replayStartOffset && payload.lastOffset <= replayEndOffset) {
    const replayBytes = Buffer.from(cliRecord.terminalReplay, 'utf8');
    const byteOffset = payload.lastOffset - replayStartOffset;
    return {
      mode: 'delta',
      sessionId,
      offset: payload.lastOffset,
      data: replayBytes.subarray(byteOffset).toString('utf8')
    };
  }

  return {
    mode: 'reset',
    sessionId,
    offset: replayStartOffset,
    data: cliRecord.terminalReplay
  };
}

function emitCliStatus(io: SocketIOServer): void {
  io.of('/web').emit('cli:update', {
    cli: cliRecord ? cloneValue(cliRecord.descriptor) : null
  } satisfies CliStatusPayload);
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, { ok: true, cliConnected: Boolean(cliRecord?.descriptor.connected) });
    return;
  }

  if (method === 'GET' && url.pathname === '/') {
    await serveWebApp(res);
    return;
  }

  if (method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'GET') {
    const publicAssetPath = resolvePublicAssetPath(url.pathname);
    if (publicAssetPath) {
      try {
        const stat = await fs.stat(publicAssetPath);
        if (stat.isFile()) {
          await serveStaticFile(res, publicAssetPath);
          return;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  json(res, 404, { error: 'Not found' });
}

function forwardCliCommand(socket: Socket, envelope: CliCommandEnvelope): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: 'CLI command timeout' });
    }, 30_000);

    socket.emit('cli:command', envelope, (result?: CliCommandResult) => {
      clearTimeout(timer);
      resolve(result?.ok ? result : { ok: false, error: result?.error || 'CLI command failed' });
    });
  });
}

async function routeWebCommand(command: WebCommandEnvelope): Promise<CliCommandResult> {
  if (!cliRecord || !cliRecord.descriptor.connected) {
    return { ok: false, error: 'CLI is offline' };
  }

  return forwardCliCommand(cliRecord.socket, {
    requestId: randomUUID(),
    name: command.name,
    payload: command.payload
  } satisfies CliCommandEnvelope);
}

export async function startSocketServer(): Promise<void> {
  if (httpServer) {
    return;
  }

  httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : 'Internal server error';
      if (!res.headersSent) {
        json(res, 500, { error: message });
        return;
      }
      res.end();
    });
  });

  const io = new SocketIOServer(httpServer, {
    path: '/socket.io/',
    cors: {
      origin: true,
      credentials: true
    }
  });

  io.of('/cli').on('connection', (socket) => {
    socket.on('cli:register', (payload: CliRegisterPayload, callback?: (result: CliRegisterResult) => void) => {
      const cliId = payload.cliId?.trim() || randomUUID();

      if (cliRecord && cliRecord.socket.id !== socket.id) {
        cliRecord.socket.disconnect(true);
      }

      cliRecord = {
        socket,
        descriptor: createCliDescriptor(cliId, payload),
        snapshot: cliRecord?.snapshot ?? null,
        terminalReplay: cliRecord?.terminalReplay ?? '',
        terminalReplayOffset: cliRecord?.terminalReplayOffset ?? 0,
        terminalReplaySessionId: cliRecord?.terminalReplaySessionId ?? null
      };
      updateDescriptorFromSnapshot(cliRecord);
      emitCliStatus(io);
      callback?.({ cliId });
    });

    socket.on('cli:snapshot', (payload: RuntimeSnapshotPayload) => {
      if (!cliRecord || cliRecord.socket.id !== socket.id) {
        return;
      }

      cliRecord.descriptor.connected = true;
      syncTerminalReplaySession(cliRecord, payload.snapshot.sessionId);
      cliRecord.snapshot = cloneValue(payload.snapshot);
      updateDescriptorFromSnapshot(cliRecord);
      io.of('/web').emit('runtime:snapshot', cloneValue(payload));
      emitCliStatus(io);
    });

    socket.on('cli:messages-upsert', (payload: MessagesUpsertPayload) => {
      if (!cliRecord || cliRecord.socket.id !== socket.id) {
        return;
      }

      cliRecord.descriptor.connected = true;
      applyMessagesUpsert(cliRecord, payload);
      updateDescriptorFromSnapshot(cliRecord);
      io.of('/web').emit('runtime:messages-upsert', cloneValue(payload));
      emitCliStatus(io);
    });

    socket.on('cli:terminal-chunk', (payload: TerminalChunkPayload) => {
      if (!cliRecord || cliRecord.socket.id !== socket.id) {
        return;
      }

      cliRecord.descriptor.connected = true;
      syncTerminalReplaySession(cliRecord, payload.sessionId);
      appendTerminalReplay(cliRecord, payload.data);
      cliRecord.descriptor.lastSeenAt = new Date().toISOString();
      io.of('/web').emit('terminal:chunk', cloneValue(payload));
    });

    socket.on('disconnect', () => {
      if (!cliRecord || cliRecord.socket.id !== socket.id) {
        return;
      }

      cliRecord.descriptor = {
        ...cliRecord.descriptor,
        connected: false,
        status: 'idle',
        lastSeenAt: new Date().toISOString()
      };
      emitCliStatus(io);
    });
  });

  io.of('/web').on('connection', (socket) => {
    socket.emit('web:init', {
      cli: cliRecord ? cloneValue(cliRecord.descriptor) : null,
      snapshot: cliRecord?.snapshot ? cloneValue(cliRecord.snapshot) : null,
      terminalReplayEndOffset: cliRecord ? getTerminalReplayEndOffset(cliRecord) : 0,
      terminalReplayStartOffset: cliRecord?.terminalReplayOffset ?? 0,
      terminalSessionId: getTerminalSessionId(cliRecord)
    } satisfies WebInitPayload);

    socket.on('web:command', async (command: WebCommandEnvelope, callback?: (result: CliCommandResult) => void) => {
      callback?.(await routeWebCommand(command));
    });

    socket.on('web:terminal-resume', (payload: TerminalResumeRequestPayload, callback?: (result: TerminalResumeResultPayload) => void) => {
      callback?.(createTerminalResumeResult(payload));
    });
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(PORT, HOST, () => {
      console.log(`socket relay listening on http://${HOST}:${PORT}`);
      resolve();
    });
  });
}
