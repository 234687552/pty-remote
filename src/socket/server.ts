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
  SelectThreadResultPayload,
  TerminalChunkPayload,
  TerminalResizePayload,
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
  terminalReplay: Buffer;
  terminalReplayOffset: number;
  terminalReplaySessionId: string | null;
}

const cliRecords = new Map<string, CliRuntimeRecord>();

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
    threadKey: payload.threadKey ?? null,
    runtimeBackend: payload.runtimeBackend,
    connected: true,
    status: 'idle',
    sessionId: payload.sessionId ?? null,
    connectedAt: now,
    lastSeenAt: now
  };
}

function listCliDescriptors(): CliDescriptor[] {
  return [...cliRecords.values()]
    .map((record) => cloneValue(record.descriptor))
    .sort((left, right) => left.label.localeCompare(right.label) || left.cliId.localeCompare(right.cliId));
}

function updateDescriptorFromSnapshot(record: CliRuntimeRecord): void {
  if (!record.snapshot) {
    return;
  }

  record.descriptor = {
    ...record.descriptor,
    threadKey: record.snapshot.threadKey,
    status: record.snapshot.status,
    sessionId: record.snapshot.sessionId,
    lastSeenAt: new Date().toISOString()
  };
}

function clearTerminalReplay(record: CliRuntimeRecord, sessionId: string | null): void {
  record.terminalReplay = Buffer.alloc(0);
  record.terminalReplayOffset = 0;
  record.terminalReplaySessionId = sessionId;
}

function setTerminalReplay(record: CliRuntimeRecord, offset: number, data: Buffer): void {
  if (data.length <= TERMINAL_REPLAY_MAX_BYTES) {
    record.terminalReplay = data;
    record.terminalReplayOffset = offset;
    return;
  }

  const start = data.length - TERMINAL_REPLAY_MAX_BYTES;
  record.terminalReplay = data.subarray(start);
  record.terminalReplayOffset = offset + start;
}

function syncTerminalReplaySession(record: CliRuntimeRecord, sessionId: string | null): void {
  if (record.terminalReplaySessionId === sessionId) {
    return;
  }
  clearTerminalReplay(record, sessionId);
}

function appendTerminalReplay(record: CliRuntimeRecord, chunkOffset: number, chunk: string): void {
  const chunkBytes = Buffer.from(chunk, 'utf8');
  const replayEndOffset = getTerminalReplayEndOffset(record);

  if (chunkOffset > replayEndOffset) {
    setTerminalReplay(record, chunkOffset, chunkBytes);
    return;
  }

  if (chunkOffset < replayEndOffset) {
    const overlapBytes = replayEndOffset - chunkOffset;
    if (overlapBytes >= chunkBytes.length) {
      return;
    }

    const suffixBytes = chunkBytes.subarray(overlapBytes);
    setTerminalReplay(record, record.terminalReplayOffset, Buffer.concat([record.terminalReplay, suffixBytes]));
    return;
  }

  setTerminalReplay(record, record.terminalReplayOffset, Buffer.concat([record.terminalReplay, chunkBytes]));
}

function getTerminalReplayEndOffset(record: CliRuntimeRecord): number {
  return record.terminalReplayOffset + record.terminalReplay.length;
}

function getTerminalSessionId(record: CliRuntimeRecord | null): string | null {
  return record?.terminalReplaySessionId ?? record?.snapshot?.sessionId ?? null;
}

function getSocketCliId(socket: Socket): string | null {
  const cliId = (socket.data as { cliId?: string }).cliId;
  return typeof cliId === 'string' && cliId.trim() ? cliId : null;
}

function getConnectedCliRecord(cliId: string | null | undefined): CliRuntimeRecord | null {
  if (!cliId) {
    return null;
  }

  const record = cliRecords.get(cliId) ?? null;
  if (!record?.descriptor.connected) {
    return null;
  }

  return record;
}

function createTerminalResumeResult(payload: TerminalResumeRequestPayload): TerminalResumeResultPayload {
  const record = getConnectedCliRecord(payload.targetCliId);
  const sessionId = getTerminalSessionId(record);
  if (!record || !sessionId) {
    return {
      mode: 'reset',
      sessionId: null,
      offset: 0,
      data: ''
    };
  }

  const replayStartOffset = record.terminalReplayOffset;
  const replayEndOffset = getTerminalReplayEndOffset(record);

  if (payload.sessionId === sessionId && payload.lastOffset >= replayStartOffset && payload.lastOffset <= replayEndOffset) {
    const byteOffset = payload.lastOffset - replayStartOffset;
    return {
      mode: 'delta',
      sessionId,
      offset: payload.lastOffset,
      data: record.terminalReplay.subarray(byteOffset).toString('utf8')
    };
  }

  return {
    mode: 'reset',
    sessionId,
    offset: replayStartOffset,
    data: record.terminalReplay.toString('utf8')
  };
}

function emitCliStatus(io: SocketIOServer): void {
  io.of('/web').emit('cli:update', {
    clis: listCliDescriptors()
  } satisfies CliStatusPayload);
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, { ok: true, cliConnected: [...cliRecords.values()].some((record) => record.descriptor.connected) });
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

function forwardCliCommand(record: CliRuntimeRecord, envelope: CliCommandEnvelope): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: 'CLI command timeout' });
    }, 30_000);

    record.socket.emit('cli:command', envelope, (result?: CliCommandResult) => {
      clearTimeout(timer);
      resolve(result?.ok ? result : { ok: false, error: result?.error || 'CLI command failed' });
    });
  });
}

async function routeWebCommand(command: WebCommandEnvelope, io: SocketIOServer): Promise<CliCommandResult> {
  const targetCliId = command.targetCliId?.trim() || null;
  if (!targetCliId) {
    return { ok: false, error: 'CLI is not selected' };
  }

  const record = getConnectedCliRecord(targetCliId);
  if (!record) {
    return { ok: false, error: 'CLI is offline' };
  }

  const result = await forwardCliCommand(record, {
    requestId: randomUUID(),
    name: command.name,
    payload: command.payload
  } satisfies CliCommandEnvelope);

  if (result.ok && command.name === 'select-thread') {
    const payload = result.payload as SelectThreadResultPayload | undefined;
    const cwd = path.resolve((command.payload as { cwd: string }).cwd);
    record.descriptor = {
      ...record.descriptor,
      cwd,
      label: path.basename(cwd) || cwd,
      threadKey: payload?.threadKey ?? (command.payload as { threadKey?: string }).threadKey ?? null,
      sessionId: payload?.sessionId ?? null,
      lastSeenAt: new Date().toISOString()
    };
    emitCliStatus(io);
  }

  return result;
}

function buildWebInitPayload(): WebInitPayload {
  return {
    clis: listCliDescriptors()
  };
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
      const previous = cliRecords.get(cliId);

      if (previous && previous.socket.id !== socket.id) {
        previous.socket.disconnect(true);
      }

      (socket.data as { cliId?: string }).cliId = cliId;

      const record: CliRuntimeRecord = {
        socket,
        descriptor: createCliDescriptor(cliId, payload),
        snapshot: previous?.snapshot ?? null,
        terminalReplay: previous?.terminalReplay ?? Buffer.alloc(0),
        terminalReplayOffset: previous?.terminalReplayOffset ?? 0,
        terminalReplaySessionId: previous?.terminalReplaySessionId ?? null
      };

      cliRecords.set(cliId, record);
      updateDescriptorFromSnapshot(record);
      emitCliStatus(io);
      callback?.({ cliId });
    });

    socket.on('cli:snapshot', (payload: RuntimeSnapshotPayload) => {
      const cliId = getSocketCliId(socket);
      if (!cliId) {
        return;
      }
      const record = cliId ? cliRecords.get(cliId) : null;
      if (!record || record.socket.id !== socket.id) {
        return;
      }

      record.descriptor.connected = true;
      syncTerminalReplaySession(record, payload.snapshot.sessionId);
      record.snapshot = cloneValue(payload.snapshot);
      updateDescriptorFromSnapshot(record);
      io.of('/web').emit('runtime:snapshot', {
        cliId,
        snapshot: cloneValue(payload.snapshot)
      } satisfies RuntimeSnapshotPayload);
      emitCliStatus(io);
    });

    socket.on('cli:messages-upsert', (payload: MessagesUpsertPayload) => {
      const cliId = getSocketCliId(socket);
      if (!cliId) {
        return;
      }
      const record = cliId ? cliRecords.get(cliId) : null;
      if (!record || record.socket.id !== socket.id) {
        return;
      }

      record.descriptor.connected = true;
      record.descriptor.lastSeenAt = new Date().toISOString();
      io.of('/web').emit('runtime:messages-upsert', {
        ...cloneValue(payload),
        cliId
      } satisfies MessagesUpsertPayload);
    });

    socket.on('cli:terminal-chunk', (payload: TerminalChunkPayload) => {
      const cliId = getSocketCliId(socket);
      if (!cliId) {
        return;
      }
      const record = cliId ? cliRecords.get(cliId) : null;
      if (!record || record.socket.id !== socket.id) {
        return;
      }

      record.descriptor.connected = true;
      syncTerminalReplaySession(record, payload.sessionId);
      appendTerminalReplay(record, payload.offset, payload.data);
      record.descriptor.lastSeenAt = new Date().toISOString();
      io.of('/web').emit('terminal:chunk', {
        ...cloneValue(payload),
        cliId
      } satisfies TerminalChunkPayload);
    });

    socket.on('disconnect', () => {
      const cliId = getSocketCliId(socket);
      const record = cliId ? cliRecords.get(cliId) : null;
      if (!record || record.socket.id !== socket.id) {
        return;
      }

      record.descriptor = {
        ...record.descriptor,
        connected: false,
        status: 'idle',
        lastSeenAt: new Date().toISOString()
      };
      emitCliStatus(io);
    });
  });

  io.of('/web').on('connection', (socket) => {
    socket.emit('web:init', buildWebInitPayload());

    socket.on('web:command', async (command: WebCommandEnvelope, callback?: (result: CliCommandResult) => void) => {
      try {
        callback?.(await routeWebCommand(command, io));
      } catch (error) {
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : 'Command failed'
        });
      }
    });

    socket.on('web:terminal-resume', (payload: TerminalResumeRequestPayload, callback?: (result: TerminalResumeResultPayload) => void) => {
      callback?.(createTerminalResumeResult(payload));
    });

    socket.on('web:terminal-resize', (payload: TerminalResizePayload) => {
      const record = getConnectedCliRecord(payload.targetCliId);
      if (!record) {
        return;
      }

      record.socket.emit('cli:terminal-resize', {
        cols: payload.cols,
        rows: payload.rows
      } satisfies Omit<TerminalResizePayload, 'targetCliId'>);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(PORT, HOST, () => {
      console.log(`socket relay listening on http://${HOST}:${PORT}`);
      resolve();
    });
  });
}
