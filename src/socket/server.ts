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
  RuntimeSubscriptionPayload,
  RuntimeSnapshotPayload,
  TerminalChunkPayload,
  TerminalResizePayload,
  TerminalResumeRequestPayload,
  TerminalResumeResultPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '../../shared/protocol.ts';
import type { CliDescriptor, CliProviderRuntimeDescriptor, ProviderId, RuntimeSnapshot, RuntimeStatus } from '../../shared/runtime-types.ts';

import { loadRelayConfig } from './relay-config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const WEB_BUILD_DIR = path.join(PUBLIC_DIR, 'build');
const WEB_BUILD_INDEX_FILE = path.join(WEB_BUILD_DIR, 'index.html');

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const TERMINAL_REPLAY_MAX_BYTES = 256 * 1024;

const relayConfig = loadRelayConfig(ROOT_DIR);

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

interface CliProviderRuntimeRecord {
  snapshot: RuntimeSnapshot | null;
  terminalReplay: Buffer;
  terminalReplayOffset: number;
  terminalReplaySessionId: string | null;
}

interface CliRuntimeRecord {
  socket: Socket;
  descriptor: CliDescriptor;
  runtimes: Partial<Record<ProviderId, CliProviderRuntimeRecord>>;
}

const cliRecords = new Map<string, CliRuntimeRecord>();
const webRuntimeSubscriptions = new Map<string, RuntimeSubscriptionPayload>();

interface RelayReplayEntry {
  seq: number;
  payload: MessagesUpsertPayload;
}

interface RelayReplayBuffer {
  nextSeq: number;
  entries: RelayReplayEntry[];
  lastAccessedAt: number;
}

interface RelaySnapshotCacheEntry {
  payload: RuntimeSnapshotPayload;
  size: number;
  lastAccessedAt: number;
}

const relayReplayBuffers = new Map<string, RelayReplayBuffer>();
const relaySnapshotCache = new Map<string, RelaySnapshotCacheEntry>();

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

function normalizeSupportedProviders(payload: CliRegisterPayload): ProviderId[] {
  return [...new Set(payload.supportedProviders)].sort();
}

function resolveConversationCacheKey(
  cliId: string | null,
  providerId: ProviderId | null,
  conversationKey: string | null,
  sessionId: string | null
): string | null {
  if (!cliId || !providerId) {
    return null;
  }
  if (conversationKey) {
    return `${cliId}:${providerId}:conversation:${conversationKey}`;
  }
  if (sessionId) {
    return `${cliId}:${providerId}:session:${sessionId}`;
  }
  return null;
}

function getReplayBuffer(cacheKey: string): RelayReplayBuffer {
  const existing = relayReplayBuffers.get(cacheKey);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }
  const created: RelayReplayBuffer = {
    nextSeq: 0,
    entries: [],
    lastAccessedAt: Date.now()
  };
  relayReplayBuffers.set(cacheKey, created);
  return created;
}

function recordReplayEntry(cacheKey: string, payload: MessagesUpsertPayload): MessagesUpsertPayload {
  const buffer = getReplayBuffer(cacheKey);
  const seq = buffer.nextSeq + 1;
  buffer.nextSeq = seq;
  const enriched = { ...payload, seq };
  buffer.entries.push({ seq, payload: enriched });
  if (buffer.entries.length > relayConfig.replayBufferSize) {
    buffer.entries.splice(0, buffer.entries.length - relayConfig.replayBufferSize);
  }
  buffer.lastAccessedAt = Date.now();
  return enriched;
}

function cacheSnapshot(payload: RuntimeSnapshotPayload): void {
  const cacheKey = resolveConversationCacheKey(
    payload.cliId,
    payload.providerId,
    payload.snapshot.conversationKey,
    payload.snapshot.sessionId
  );
  if (!cacheKey) {
    return;
  }
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size > relayConfig.snapshotMaxBytes) {
    relaySnapshotCache.delete(cacheKey);
    return;
  }
  relaySnapshotCache.set(cacheKey, {
    payload: cloneValue(payload),
    size,
    lastAccessedAt: Date.now()
  });
  if (relaySnapshotCache.size <= relayConfig.snapshotCacheMax) {
    return;
  }
  const entries = [...relaySnapshotCache.entries()].sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
  const excess = relaySnapshotCache.size - relayConfig.snapshotCacheMax;
  for (let i = 0; i < excess; i += 1) {
    relaySnapshotCache.delete(entries[i]?.[0] ?? '');
  }
}

function emitCachedSnapshotToSocket(socket: Socket, subscription: RuntimeSubscriptionPayload): boolean {
  if (!hasRuntimeSubscriptionTarget(subscription) || !hasRuntimeSubscriptionConversation(subscription)) {
    return false;
  }
  const cacheKey = resolveConversationCacheKey(
    subscription.targetCliId,
    subscription.targetProviderId,
    subscription.conversationKey,
    subscription.sessionId
  );
  if (!cacheKey) {
    return false;
  }
  const cached = relaySnapshotCache.get(cacheKey);
  if (!cached) {
    return false;
  }
  cached.lastAccessedAt = Date.now();
  socket.emit('runtime:snapshot', cloneValue(cached.payload));
  return true;
}

function replayMessagesToSocket(socket: Socket, subscription: RuntimeSubscriptionPayload): boolean {
  if (!hasRuntimeSubscriptionTarget(subscription) || !hasRuntimeSubscriptionConversation(subscription)) {
    return false;
  }
  if (subscription.lastSeq == null) {
    return false;
  }
  const cacheKey = resolveConversationCacheKey(
    subscription.targetCliId,
    subscription.targetProviderId,
    subscription.conversationKey,
    subscription.sessionId
  );
  if (!cacheKey) {
    return false;
  }
  const buffer = relayReplayBuffers.get(cacheKey);
  if (!buffer || buffer.entries.length === 0) {
    return false;
  }
  const oldestSeq = buffer.entries[0]?.seq ?? null;
  if (oldestSeq === null || subscription.lastSeq < oldestSeq) {
    return false;
  }
  const entries = buffer.entries.filter((entry) => entry.seq > (subscription.lastSeq ?? 0));
  if (entries.length === 0) {
    return true;
  }
  for (const entry of entries) {
    socket.emit('runtime:messages-upsert', cloneValue(entry.payload));
  }
  buffer.lastAccessedAt = Date.now();
  return true;
}

function createProviderRuntimeDescriptor(
  payload: CliRegisterPayload,
  providerId: ProviderId
): CliProviderRuntimeDescriptor {
  const registration = payload.runtimes[providerId];
  return {
    cwd: registration?.cwd ?? payload.cwd,
    conversationKey: registration?.conversationKey ?? null,
    status: 'idle',
    sessionId: registration?.sessionId ?? null
  };
}

function createProviderRuntimeRecord(
  payload: CliRegisterPayload,
  providerId: ProviderId,
  previous?: CliProviderRuntimeRecord | null
): CliProviderRuntimeRecord {
  return {
    snapshot: previous?.snapshot ?? null,
    terminalReplay: previous?.terminalReplay ?? Buffer.alloc(0),
    terminalReplayOffset: previous?.terminalReplayOffset ?? 0,
    terminalReplaySessionId: previous?.terminalReplaySessionId ?? null
  };
}

function createCliDescriptor(cliId: string, payload: CliRegisterPayload): CliDescriptor {
  const now = new Date().toISOString();
  const supportedProviders = normalizeSupportedProviders(payload);
  return {
    cliId,
    label: payload.label?.trim() || path.basename(payload.cwd) || cliId,
    cwd: payload.cwd,
    supportedProviders,
    runtimes: Object.fromEntries(
      supportedProviders.map((providerId) => [providerId, createProviderRuntimeDescriptor(payload, providerId)])
    ),
    runtimeBackend: payload.runtimeBackend,
    connected: true,
    connectedAt: now,
    lastSeenAt: now
  };
}

function listCliDescriptors(): CliDescriptor[] {
  return [...cliRecords.values()]
    .map((record) => cloneValue(record.descriptor))
    .sort((left, right) => left.label.localeCompare(right.label) || left.cliId.localeCompare(right.cliId));
}

function getProviderRecord(record: CliRuntimeRecord, providerId: ProviderId): CliProviderRuntimeRecord | null {
  return record.runtimes[providerId] ?? null;
}

function updateDescriptorFromSnapshot(record: CliRuntimeRecord, providerId: ProviderId): void {
  const providerRecord = getProviderRecord(record, providerId);
  if (!providerRecord?.snapshot) {
    return;
  }

  record.descriptor = {
    ...record.descriptor,
    runtimes: {
      ...record.descriptor.runtimes,
      [providerId]: {
        cwd: record.descriptor.runtimes[providerId]?.cwd ?? record.descriptor.cwd,
        conversationKey: providerRecord.snapshot.conversationKey,
        status: providerRecord.snapshot.status,
        sessionId: providerRecord.snapshot.sessionId
      }
    },
    lastSeenAt: new Date().toISOString()
  };
}

function clearTerminalReplay(record: CliProviderRuntimeRecord, sessionId: string | null): void {
  record.terminalReplay = Buffer.alloc(0);
  record.terminalReplayOffset = 0;
  record.terminalReplaySessionId = sessionId;
}

function setTerminalReplay(record: CliProviderRuntimeRecord, offset: number, data: Buffer): void {
  if (data.length <= TERMINAL_REPLAY_MAX_BYTES) {
    record.terminalReplay = data;
    record.terminalReplayOffset = offset;
    return;
  }

  const start = data.length - TERMINAL_REPLAY_MAX_BYTES;
  record.terminalReplay = data.subarray(start);
  record.terminalReplayOffset = offset + start;
}

function syncTerminalReplaySession(record: CliProviderRuntimeRecord, sessionId: string | null): void {
  if (record.terminalReplaySessionId === sessionId) {
    return;
  }
  clearTerminalReplay(record, sessionId);
}

function appendTerminalReplay(record: CliProviderRuntimeRecord, chunkOffset: number, chunk: string): void {
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

function getTerminalReplayEndOffset(record: CliProviderRuntimeRecord): number {
  return record.terminalReplayOffset + record.terminalReplay.length;
}

function getTerminalSessionId(record: CliProviderRuntimeRecord | null): string | null {
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

function isProviderId(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex';
}

function normalizeRuntimeSubscription(payload?: Partial<RuntimeSubscriptionPayload> | null): RuntimeSubscriptionPayload {
  const targetCliId =
    typeof payload?.targetCliId === 'string' && payload.targetCliId.trim().length > 0 ? payload.targetCliId.trim() : null;
  const targetProviderId = isProviderId(payload?.targetProviderId) ? payload.targetProviderId : null;
  const conversationKey =
    typeof payload?.conversationKey === 'string' && payload.conversationKey.trim().length > 0 ? payload.conversationKey.trim() : null;
  const sessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0 ? payload.sessionId.trim() : null;
  const lastSeq = typeof payload?.lastSeq === 'number' && Number.isFinite(payload.lastSeq) ? payload.lastSeq : null;
  return {
    targetCliId,
    targetProviderId,
    conversationKey,
    sessionId,
    lastSeq
  };
}

function hasRuntimeSubscriptionTarget(subscription: RuntimeSubscriptionPayload): boolean {
  return subscription.targetCliId !== null && subscription.targetProviderId !== null;
}

function hasRuntimeSubscriptionConversation(subscription: RuntimeSubscriptionPayload): boolean {
  return subscription.conversationKey !== null || subscription.sessionId !== null;
}

function matchesRuntimeSnapshotSubscription(subscription: RuntimeSubscriptionPayload, payload: RuntimeSnapshotPayload): boolean {
  if (!hasRuntimeSubscriptionTarget(subscription)) {
    return false;
  }
  if (!hasRuntimeSubscriptionConversation(subscription)) {
    return false;
  }
  if (payload.cliId !== subscription.targetCliId || payload.providerId !== subscription.targetProviderId) {
    return false;
  }
  if (subscription.conversationKey !== null && payload.snapshot.conversationKey !== subscription.conversationKey) {
    return false;
  }
  if (subscription.sessionId !== null && payload.snapshot.sessionId !== subscription.sessionId) {
    return false;
  }
  return true;
}

function matchesMessagesUpsertSubscription(subscription: RuntimeSubscriptionPayload, payload: MessagesUpsertPayload): boolean {
  if (!hasRuntimeSubscriptionTarget(subscription)) {
    return false;
  }
  if (!hasRuntimeSubscriptionConversation(subscription)) {
    return false;
  }
  if (payload.cliId !== subscription.targetCliId || payload.providerId !== subscription.targetProviderId) {
    return false;
  }
  if (subscription.conversationKey !== null && payload.conversationKey !== subscription.conversationKey) {
    return false;
  }
  if (subscription.sessionId !== null && payload.sessionId !== subscription.sessionId) {
    return false;
  }
  return true;
}

function matchesTerminalChunkSubscription(subscription: RuntimeSubscriptionPayload, payload: TerminalChunkPayload): boolean {
  if (!hasRuntimeSubscriptionTarget(subscription)) {
    return false;
  }
  if (!hasRuntimeSubscriptionConversation(subscription)) {
    return false;
  }
  if (payload.cliId !== subscription.targetCliId || payload.providerId !== subscription.targetProviderId) {
    return false;
  }
  if (subscription.conversationKey !== null && payload.conversationKey !== subscription.conversationKey) {
    return false;
  }
  if (subscription.sessionId !== null && payload.sessionId !== subscription.sessionId) {
    return false;
  }
  return true;
}

function matchesProviderRuntimeSubscription(
  subscription: RuntimeSubscriptionPayload,
  cliId: string,
  providerId: ProviderId,
  providerRecord: CliProviderRuntimeRecord
): boolean {
  if (!hasRuntimeSubscriptionTarget(subscription)) {
    return false;
  }
  if (!hasRuntimeSubscriptionConversation(subscription)) {
    return false;
  }
  if (subscription.targetCliId !== cliId || subscription.targetProviderId !== providerId) {
    return false;
  }

  const snapshotConversationKey = providerRecord.snapshot?.conversationKey ?? null;
  const terminalSessionId = getTerminalSessionId(providerRecord);

  if (subscription.conversationKey !== null && snapshotConversationKey !== subscription.conversationKey) {
    return false;
  }
  if (subscription.sessionId !== null && terminalSessionId !== subscription.sessionId) {
    return false;
  }
  return true;
}

function emitCurrentRuntimeSnapshotToSocket(socket: Socket, subscription: RuntimeSubscriptionPayload): void {
  if (!hasRuntimeSubscriptionTarget(subscription)) {
    return;
  }

  const record = getConnectedCliRecord(subscription.targetCliId);
  const providerId = subscription.targetProviderId;
  if (!record || !providerId) {
    return;
  }

  const providerRecord = getProviderRecord(record, providerId);
  if (!providerRecord?.snapshot || !matchesProviderRuntimeSubscription(subscription, record.descriptor.cliId, providerId, providerRecord)) {
    return;
  }

  socket.emit('runtime:snapshot', {
    cliId: record.descriptor.cliId,
    providerId,
    snapshot: cloneValue(providerRecord.snapshot)
  } satisfies RuntimeSnapshotPayload);
}

function emitRuntimeSnapshotToSubscribers(io: SocketIOServer, payload: RuntimeSnapshotPayload): void {
  for (const socket of io.of('/web').sockets.values()) {
    const subscription = webRuntimeSubscriptions.get(socket.id);
    if (!subscription || !matchesRuntimeSnapshotSubscription(subscription, payload)) {
      continue;
    }
    socket.emit('runtime:snapshot', payload);
  }
}

function emitMessagesUpsertToSubscribers(io: SocketIOServer, payload: MessagesUpsertPayload): void {
  for (const socket of io.of('/web').sockets.values()) {
    const subscription = webRuntimeSubscriptions.get(socket.id);
    if (!subscription || !matchesMessagesUpsertSubscription(subscription, payload)) {
      continue;
    }
    socket.emit('runtime:messages-upsert', payload);
  }
}

function emitTerminalChunkToSubscribers(io: SocketIOServer, payload: TerminalChunkPayload): void {
  for (const socket of io.of('/web').sockets.values()) {
    const subscription = webRuntimeSubscriptions.get(socket.id);
    if (!subscription || !matchesTerminalChunkSubscription(subscription, payload)) {
      continue;
    }
    socket.emit('terminal:chunk', payload);
  }
}

function createTerminalResumeResult(socket: Socket, payload: TerminalResumeRequestPayload): TerminalResumeResultPayload {
  const subscription = webRuntimeSubscriptions.get(socket.id);
  const record = getConnectedCliRecord(payload.targetCliId);
  const providerId = payload.targetProviderId ?? null;
  const providerRecord = record && providerId ? getProviderRecord(record, providerId) : null;
  if (
    !record ||
    !providerId ||
    !providerRecord ||
    !subscription ||
    !matchesProviderRuntimeSubscription(subscription, record.descriptor.cliId, providerId, providerRecord)
  ) {
    return {
      providerId,
      mode: 'reset',
      sessionId: null,
      offset: 0,
      data: ''
    };
  }

  const sessionId = getTerminalSessionId(providerRecord);
  if (!sessionId) {
    return {
      providerId,
      mode: 'reset',
      sessionId: null,
      offset: 0,
      data: ''
    };
  }

  const replayStartOffset = providerRecord.terminalReplayOffset;
  const replayEndOffset = getTerminalReplayEndOffset(providerRecord);

  if (payload.sessionId === sessionId && payload.lastOffset >= replayStartOffset && payload.lastOffset <= replayEndOffset) {
    const byteOffset = payload.lastOffset - replayStartOffset;
    return {
      providerId,
      mode: 'delta',
      sessionId,
      offset: payload.lastOffset,
      data: providerRecord.terminalReplay.subarray(byteOffset).toString('utf8')
    };
  }

  return {
    providerId,
    mode: 'reset',
    sessionId,
    offset: replayStartOffset,
    data: providerRecord.terminalReplay.toString('utf8')
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
    targetProviderId: command.targetProviderId ?? null,
    name: command.name,
    payload: command.payload
  } satisfies CliCommandEnvelope);

  if (result.ok && command.name === 'select-conversation') {
    const providerId = command.targetProviderId ?? null;
    const payload = result.payload as { conversationKey?: string | null; sessionId?: string | null } | undefined;
    const cwd = path.resolve((command.payload as { cwd: string }).cwd);
    const currentRuntime = providerId ? record.descriptor.runtimes[providerId] : null;
    record.descriptor = {
      ...record.descriptor,
      cwd: providerId && providerId === record.descriptor.supportedProviders[0] ? cwd : record.descriptor.cwd,
      runtimes:
        providerId === null
          ? record.descriptor.runtimes
          : {
              ...record.descriptor.runtimes,
              [providerId]: {
                cwd,
                conversationKey:
                  payload?.conversationKey ?? (command.payload as { conversationKey?: string }).conversationKey ?? null,
                sessionId: payload?.sessionId ?? null,
                status: currentRuntime?.status ?? 'idle'
              }
            },
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

      if (previous?.descriptor.connected && previous.socket.id !== socket.id) {
        callback?.({
          ok: false,
          cliId,
          error: `CLI ${cliId} is already connected`
        });
        socket.disconnect(true);
        return;
      }

      (socket.data as { cliId?: string }).cliId = cliId;

      const record: CliRuntimeRecord = {
        socket,
        descriptor: createCliDescriptor(cliId, payload),
        runtimes: Object.fromEntries(
          normalizeSupportedProviders(payload).map((providerId) => [
            providerId,
            createProviderRuntimeRecord(payload, providerId, previous ? getProviderRecord(previous, providerId) : null)
          ])
        )
      };

      cliRecords.set(cliId, record);
      for (const providerId of record.descriptor.supportedProviders) {
        updateDescriptorFromSnapshot(record, providerId);
      }
      emitCliStatus(io);
      callback?.({
        ok: true,
        cliId
      });
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

      const providerRecord = getProviderRecord(record, payload.providerId);
      if (!providerRecord) {
        return;
      }

      record.descriptor.connected = true;
      syncTerminalReplaySession(providerRecord, payload.snapshot.sessionId);
      providerRecord.snapshot = cloneValue(payload.snapshot);
      updateDescriptorFromSnapshot(record, payload.providerId);
      const snapshotPayload = {
        cliId,
        providerId: payload.providerId,
        snapshot: cloneValue(payload.snapshot)
      } satisfies RuntimeSnapshotPayload;
      cacheSnapshot(snapshotPayload);
      emitRuntimeSnapshotToSubscribers(io, snapshotPayload);
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
      const basePayload = {
        ...cloneValue(payload),
        cliId
      } satisfies MessagesUpsertPayload;
      const cacheKey = resolveConversationCacheKey(
        cliId,
        basePayload.providerId ?? null,
        basePayload.conversationKey ?? null,
        basePayload.sessionId ?? null
      );
      const messagesPayload = cacheKey ? recordReplayEntry(cacheKey, basePayload) : basePayload;
      emitMessagesUpsertToSubscribers(io, messagesPayload);
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

      const providerRecord = getProviderRecord(record, payload.providerId);
      if (!providerRecord) {
        return;
      }

      record.descriptor.connected = true;
      syncTerminalReplaySession(providerRecord, payload.sessionId);
      appendTerminalReplay(providerRecord, payload.offset, payload.data);
      record.descriptor.lastSeenAt = new Date().toISOString();
      const terminalChunkPayload = {
        ...cloneValue(payload),
        cliId
      } satisfies TerminalChunkPayload;
      emitTerminalChunkToSubscribers(io, terminalChunkPayload);
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
        runtimes: Object.fromEntries(
          record.descriptor.supportedProviders.map((providerId) => [
            providerId,
            {
              ...(record.descriptor.runtimes[providerId] ?? {
                cwd: record.descriptor.cwd,
                conversationKey: null,
                sessionId: null,
                status: 'idle' as RuntimeStatus
              }),
              status: 'idle' as RuntimeStatus
            }
          ])
        ),
        lastSeenAt: new Date().toISOString()
      };
      emitCliStatus(io);
    });
  });

  io.of('/web').on('connection', (socket) => {
    webRuntimeSubscriptions.set(socket.id, normalizeRuntimeSubscription());
    socket.emit('web:init', buildWebInitPayload());

    socket.on('web:runtime-subscribe', (payload: RuntimeSubscriptionPayload) => {
      const subscription = normalizeRuntimeSubscription(payload);
      webRuntimeSubscriptions.set(socket.id, subscription);
      if (replayMessagesToSocket(socket, subscription)) {
        return;
      }
      if (emitCachedSnapshotToSocket(socket, subscription)) {
        return;
      }
      emitCurrentRuntimeSnapshotToSocket(socket, subscription);
    });

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
      callback?.(createTerminalResumeResult(socket, payload));
    });

    socket.on('web:terminal-resize', (payload: TerminalResizePayload) => {
      const record = getConnectedCliRecord(payload.targetCliId);
      if (!record) {
        return;
      }

      record.socket.emit('cli:terminal-resize', {
        targetProviderId: payload.targetProviderId,
        cols: payload.cols,
        rows: payload.rows
      } satisfies Omit<TerminalResizePayload, 'targetCliId'>);
    });

    socket.on('disconnect', () => {
      webRuntimeSubscriptions.delete(socket.id);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(PORT, HOST, () => {
      console.log(`socket relay listening on http://${HOST}:${PORT}`);
      resolve();
    });
  });
}
