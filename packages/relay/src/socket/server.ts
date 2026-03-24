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
  TerminalFramePatchPayload,
  TerminalFrameSyncRequestPayload,
  TerminalFrameSyncResultPayload,
  TerminalSessionEvictedPayload,
  TerminalResizePayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { CliDescriptor, CliProviderRuntimeDescriptor, ProviderId, RuntimeSnapshot, RuntimeStatus } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import { applyTerminalFramePatch, cloneTerminalFrameSnapshot, type TerminalFramePatch, type TerminalFrameSnapshot } from '@lzdi/pty-remote-protocol/terminal-frame.ts';

import { loadRelayConfig } from './relay-config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const WEB_BUILD_DIR = path.join(PUBLIC_DIR, 'build');
const WEB_BUILD_INDEX_FILE = path.join(WEB_BUILD_DIR, 'index.html');

const relayConfig = loadRelayConfig(ROOT_DIR);
const PORT = Number.parseInt(process.env.PORT ?? String(relayConfig.port), 10);
const HOST = process.env.HOST ?? relayConfig.host;
const SOCKET_MAX_HTTP_BUFFER_SIZE = relayConfig.socketMaxHttpBufferSize;
const CLI_COMMAND_TIMEOUT_MS = relayConfig.cliCommandTimeoutMs;
const TERMINAL_FRAME_PATCH_HISTORY_LIMIT = 256;
const TERMINAL_SESSION_CACHE_MAX = 8;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

interface CliProviderRuntimeRecord {
  snapshot: RuntimeSnapshot | null;
  terminalSessions: Map<string, TerminalSessionCacheEntry>;
}

interface TerminalSessionCacheEntry {
  conversationKey: string | null;
  patches: TerminalFramePatch[];
  snapshot: TerminalFrameSnapshot;
  updatedAt: number;
}

interface CliRuntimeRecord {
  socket: Socket;
  descriptor: CliDescriptor;
  disconnectedAt: number | null;
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

function relayErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function logRelay(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
  const logger = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
  if (details) {
    logger(`[pty-remote][relay] ${message}`, details);
    return;
  }
  logger(`[pty-remote][relay] ${message}`);
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

function createProviderRuntimeRecord(previous?: CliProviderRuntimeRecord | null): CliProviderRuntimeRecord {
  return {
    snapshot: previous?.snapshot ?? null,
    terminalSessions: cloneTerminalSessions(previous?.terminalSessions)
  };
}

function cloneTerminalSessions(
  source: Map<string, TerminalSessionCacheEntry> | undefined
): Map<string, TerminalSessionCacheEntry> {
  const cloned = new Map<string, TerminalSessionCacheEntry>();
  if (!source) {
    return cloned;
  }
  for (const [sessionId, entry] of source.entries()) {
    cloned.set(sessionId, {
      conversationKey: entry.conversationKey,
      patches: entry.patches.map((patch) => cloneValue(patch)),
      snapshot: cloneTerminalFrameSnapshot(entry.snapshot),
      updatedAt: entry.updatedAt
    });
  }
  return cloned;
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

function getActiveConversationCacheKeys(): Set<string> {
  const keys = new Set<string>();
  for (const subscription of webRuntimeSubscriptions.values()) {
    const cacheKey = resolveConversationCacheKey(
      subscription.targetCliId,
      subscription.targetProviderId,
      subscription.conversationKey,
      subscription.sessionId
    );
    if (cacheKey) {
      keys.add(cacheKey);
    }
  }
  return keys;
}

function getSubscribedCliIds(): Set<string> {
  const cliIds = new Set<string>();
  for (const subscription of webRuntimeSubscriptions.values()) {
    const cliId = subscription.targetCliId?.trim();
    if (cliId) {
      cliIds.add(cliId);
    }
  }
  return cliIds;
}

function dropConversationCachesForCli(cliId: string, retainedKeys: Set<string>): void {
  const cliPrefix = `${cliId}:`;
  for (const cacheKey of relayReplayBuffers.keys()) {
    if (cacheKey.startsWith(cliPrefix) && !retainedKeys.has(cacheKey)) {
      relayReplayBuffers.delete(cacheKey);
    }
  }
  for (const cacheKey of relaySnapshotCache.keys()) {
    if (cacheKey.startsWith(cliPrefix) && !retainedKeys.has(cacheKey)) {
      relaySnapshotCache.delete(cacheKey);
    }
  }
}

function pruneReplayBuffers(activeCacheKeys: Set<string>, now = Date.now()): void {
  for (const [cacheKey, buffer] of relayReplayBuffers.entries()) {
    if (activeCacheKeys.has(cacheKey)) {
      continue;
    }
    if (now - buffer.lastAccessedAt >= relayConfig.replayBufferTtlMs) {
      relayReplayBuffers.delete(cacheKey);
    }
  }

  if (relayReplayBuffers.size <= relayConfig.replayBufferKeysMax) {
    return;
  }

  const evictable = [...relayReplayBuffers.entries()]
    .filter(([cacheKey]) => !activeCacheKeys.has(cacheKey))
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
  while (relayReplayBuffers.size > relayConfig.replayBufferKeysMax && evictable.length > 0) {
    const candidate = evictable.shift();
    if (!candidate) {
      break;
    }
    relayReplayBuffers.delete(candidate[0]);
  }
}

function pruneCliRecords(io: SocketIOServer, subscribedCliIds: Set<string>, retainedKeys: Set<string>, now = Date.now()): void {
  let changed = false;
  for (const [cliId, record] of cliRecords.entries()) {
    if (record.descriptor.connected) {
      record.disconnectedAt = null;
      continue;
    }
    if (subscribedCliIds.has(cliId)) {
      continue;
    }
    const lastSeenAtMs = record.descriptor.lastSeenAt ? Date.parse(record.descriptor.lastSeenAt) : Number.NaN;
    const disconnectedAt = record.disconnectedAt ?? (Number.isFinite(lastSeenAtMs) ? lastSeenAtMs : now);
    if (now - disconnectedAt < relayConfig.disconnectedCliTtlMs) {
      continue;
    }
    cliRecords.delete(cliId);
    dropConversationCachesForCli(cliId, retainedKeys);
    changed = true;
  }

  if (changed) {
    emitCliStatus(io);
  }
}

function pruneRelayState(io: SocketIOServer): void {
  const now = Date.now();
  const activeCacheKeys = getActiveConversationCacheKeys();
  const subscribedCliIds = getSubscribedCliIds();
  pruneReplayBuffers(activeCacheKeys, now);
  pruneCliRecords(io, subscribedCliIds, activeCacheKeys, now);
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

function pruneTerminalSessions(record: CliProviderRuntimeRecord): void {
  if (record.terminalSessions.size <= TERMINAL_SESSION_CACHE_MAX) {
    return;
  }
  const evictions = [...record.terminalSessions.entries()]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, Math.max(0, record.terminalSessions.size - TERMINAL_SESSION_CACHE_MAX));
  for (const [sessionId] of evictions) {
    record.terminalSessions.delete(sessionId);
  }
}

function getTerminalSessionCache(
  record: CliProviderRuntimeRecord | null,
  sessionId: string | null | undefined
): TerminalSessionCacheEntry | null {
  const normalizedSessionId = sessionId?.trim() || null;
  if (!record || !normalizedSessionId) {
    return null;
  }
  return record.terminalSessions.get(normalizedSessionId) ?? null;
}

function deleteTerminalSessionCache(record: CliProviderRuntimeRecord, sessionId: string | null | undefined): void {
  const normalizedSessionId = sessionId?.trim() || null;
  if (!normalizedSessionId) {
    return;
  }
  record.terminalSessions.delete(normalizedSessionId);
}

function appendTerminalFramePatch(
  record: CliProviderRuntimeRecord,
  patch: TerminalFramePatch,
  conversationKey: string | null
): boolean {
  const sessionId = patch.sessionId?.trim() || null;
  if (!sessionId) {
    return false;
  }
  const isResetPatch = patch.ops.some((op) => op.type === 'reset');
  if (isResetPatch) {
    record.terminalSessions.set(sessionId, {
      conversationKey,
      patches: [cloneValue(patch)],
      snapshot: applyTerminalFramePatch(null, patch),
      updatedAt: Date.now()
    });
    pruneTerminalSessions(record);
    return true;
  }

  const currentSession = getTerminalSessionCache(record, sessionId);
  if (!currentSession || currentSession.snapshot.revision !== patch.baseRevision) {
    deleteTerminalSessionCache(record, sessionId);
    return false;
  }

  currentSession.snapshot = applyTerminalFramePatch(currentSession.snapshot, patch);
  currentSession.conversationKey = conversationKey;
  currentSession.patches.push(cloneValue(patch));
  if (currentSession.patches.length > TERMINAL_FRAME_PATCH_HISTORY_LIMIT) {
    currentSession.patches.splice(0, currentSession.patches.length - TERMINAL_FRAME_PATCH_HISTORY_LIMIT);
  }
  currentSession.updatedAt = Date.now();
  return true;
}

function getTerminalFramePatchesSince(
  record: CliProviderRuntimeRecord,
  sessionId: string,
  lastRevision: number
): TerminalFramePatch[] | null {
  const sessionCache = getTerminalSessionCache(record, sessionId);
  if (!sessionCache) {
    return null;
  }
  const currentSnapshot = sessionCache.snapshot;
  if (lastRevision === currentSnapshot.revision) {
    return [];
  }
  if (lastRevision > currentSnapshot.revision) {
    return null;
  }

  const selected: TerminalFramePatch[] = [];
  let expectedBaseRevision = lastRevision;

  for (const patch of sessionCache.patches) {
    if (patch.revision <= lastRevision) {
      continue;
    }
    if (patch.baseRevision !== expectedBaseRevision) {
      return null;
    }
    selected.push(cloneValue(patch));
    expectedBaseRevision = patch.revision;
    if (expectedBaseRevision === currentSnapshot.revision) {
      return selected;
    }
  }

  return null;
}

function getTerminalSessionId(record: CliProviderRuntimeRecord | null): string | null {
  return record?.snapshot?.sessionId ?? null;
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
  const terminalEnabled = payload?.terminalEnabled === true;
  return {
    targetCliId,
    targetProviderId,
    conversationKey,
    sessionId,
    lastSeq,
    terminalEnabled
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

function matchesTerminalFramePatchSubscription(subscription: RuntimeSubscriptionPayload, payload: TerminalFramePatchPayload): boolean {
  if (subscription.terminalEnabled !== true) {
    return false;
  }
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
  if (subscription.sessionId !== null && payload.patch.sessionId !== subscription.sessionId) {
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

  const terminalSessionId = subscription.sessionId ?? getTerminalSessionId(providerRecord);
  const terminalSessionCache = getTerminalSessionCache(providerRecord, terminalSessionId);
  const conversationKeyForMatch =
    subscription.sessionId !== null
      ? terminalSessionCache?.conversationKey ?? null
      : providerRecord.snapshot?.conversationKey ?? null;

  if (subscription.conversationKey !== null && conversationKeyForMatch !== subscription.conversationKey) {
    return false;
  }
  if (subscription.sessionId !== null && !terminalSessionCache) {
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
    if (!subscription) {
      continue;
    }
    if (!matchesMessagesUpsertSubscription(subscription, payload)) {
      continue;
    }
    socket.emit('runtime:messages-upsert', payload);
  }
}

function emitTerminalFramePatchToSubscribers(io: SocketIOServer, payload: TerminalFramePatchPayload): void {
  for (const socket of io.of('/web').sockets.values()) {
    const subscription = webRuntimeSubscriptions.get(socket.id);
    if (!subscription || !matchesTerminalFramePatchSubscription(subscription, payload)) {
      continue;
    }
    socket.emit('terminal:frame-patch', payload);
  }
}

async function createTerminalFrameSyncResult(socket: Socket, payload: TerminalFrameSyncRequestPayload): Promise<TerminalFrameSyncResultPayload> {
  const subscription = webRuntimeSubscriptions.get(socket.id);
  const record = getConnectedCliRecord(payload.targetCliId);
  const providerId = payload.targetProviderId ?? null;
  const providerRecord = record && providerId ? getProviderRecord(record, providerId) : null;
  const requestedSessionId = payload.sessionId ?? providerRecord?.snapshot?.sessionId ?? null;
  let terminalSessionCache = getTerminalSessionCache(providerRecord, requestedSessionId);
  const isActiveSessionRequest = requestedSessionId !== null && requestedSessionId === providerRecord?.snapshot?.sessionId;
  const terminalFrameSnapshot = terminalSessionCache?.snapshot ?? null;

  if (
    !record ||
    !providerId ||
    !providerRecord ||
    !subscription ||
    !matchesProviderRuntimeSubscription(subscription, record.descriptor.cliId, providerId, providerRecord) ||
    !terminalSessionCache ||
    !terminalFrameSnapshot
  ) {
    if (record && providerId && providerRecord && subscription && isActiveSessionRequest) {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        record.socket.emit('cli:terminal-frame-prime', { targetProviderId: providerId }, (ack?: { ok: boolean; error?: string }) => {
          resolve(ack ?? { ok: false, error: 'No response from CLI terminal frame priming' });
        });
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || 'Failed to prepare terminal frame',
          providerId,
          sessionId: requestedSessionId
        };
      }

      terminalSessionCache = getTerminalSessionCache(providerRecord, requestedSessionId);
      if (terminalSessionCache?.snapshot) {
        return {
          ok: true,
          providerId,
          sessionId: terminalSessionCache.snapshot.sessionId,
          mode: 'snapshot',
          snapshot: cloneTerminalFrameSnapshot(terminalSessionCache.snapshot)
        };
      }
    }

    return {
      ok: false,
      error: 'Terminal frame is unavailable for the requested runtime',
      providerId,
      sessionId: null
    };
  }

  const resolvedTerminalSessionCache = terminalSessionCache;

  if (
    payload.sessionId === terminalFrameSnapshot.sessionId &&
    payload.lastRevision != null
  ) {
    const patches = getTerminalFramePatchesSince(providerRecord, terminalFrameSnapshot.sessionId ?? '', payload.lastRevision);
    if (patches) {
      resolvedTerminalSessionCache.updatedAt = Date.now();
      return {
        ok: true,
        providerId,
        sessionId: terminalFrameSnapshot.sessionId,
        mode: 'patches',
        patches
      };
    }
  }

  resolvedTerminalSessionCache.updatedAt = Date.now();
  return {
    ok: true,
    providerId,
    sessionId: terminalFrameSnapshot.sessionId,
    mode: 'snapshot',
    snapshot: cloneTerminalFrameSnapshot(terminalFrameSnapshot)
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
      logRelay('error', 'cli command timed out', {
        cliId: record.descriptor.cliId,
        command: envelope.name,
        requestId: envelope.requestId,
        targetProviderId: envelope.targetProviderId ?? null,
        timeoutMs: CLI_COMMAND_TIMEOUT_MS
      });
      resolve({ ok: false, error: 'CLI command timeout' });
    }, CLI_COMMAND_TIMEOUT_MS);

    record.socket.emit('cli:command', envelope, (result?: CliCommandResult) => {
      clearTimeout(timer);
      if (!result?.ok) {
        logRelay('error', 'cli command returned failure', {
          cliId: record.descriptor.cliId,
          command: envelope.name,
          error: result?.error || 'CLI command failed',
          requestId: envelope.requestId,
          targetProviderId: envelope.targetProviderId ?? null
        });
      }
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
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
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
          errorCode: 'conflict',
          error: `CLI ${cliId} is already connected`
        });
        return;
      }

      (socket.data as { cliId?: string }).cliId = cliId;

      const record: CliRuntimeRecord = {
        socket,
        descriptor: createCliDescriptor(cliId, payload),
        disconnectedAt: null,
        runtimes: Object.fromEntries(
          normalizeSupportedProviders(payload).map((providerId) => [
            providerId,
            createProviderRuntimeRecord(previous ? getProviderRecord(previous, providerId) : null)
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
      record.disconnectedAt = null;
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
      record.disconnectedAt = null;
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

    socket.on('cli:terminal-frame-patch', (payload: TerminalFramePatchPayload) => {
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
      record.disconnectedAt = null;
      record.descriptor.lastSeenAt = new Date().toISOString();
      if (!appendTerminalFramePatch(providerRecord, payload.patch, payload.conversationKey ?? null)) {
        return;
      }
      emitTerminalFramePatchToSubscribers(io, {
        ...cloneValue(payload),
        cliId
      } satisfies TerminalFramePatchPayload);
    });

    socket.on('cli:terminal-session-evicted', (payload: TerminalSessionEvictedPayload) => {
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

      deleteTerminalSessionCache(providerRecord, payload.sessionId);
      record.disconnectedAt = null;
      record.descriptor.lastSeenAt = new Date().toISOString();
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
      record.disconnectedAt = Date.now();
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
        logRelay('error', 'web command routing failed', {
          command: command.name,
          error: relayErrorMessage(error, 'Command failed'),
          socketId: socket.id,
          targetCliId: command.targetCliId,
          targetProviderId: command.targetProviderId ?? null
        });
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : 'Command failed'
        });
      }
    });

    socket.on(
      'web:terminal-frame-sync',
      async (payload: TerminalFrameSyncRequestPayload, callback?: (result: TerminalFrameSyncResultPayload) => void) => {
        callback?.(await createTerminalFrameSyncResult(socket, payload));
      }
    );

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
      pruneRelayState(io);
    });
  });

  const relayGcTimer = setInterval(() => {
    pruneRelayState(io);
  }, relayConfig.cacheGcIntervalMs);
  relayGcTimer.unref();

  await new Promise<void>((resolve) => {
    httpServer!.listen(PORT, HOST, () => {
      console.log(`socket relay listening on http://${HOST}:${PORT}`);
      resolve();
    });
  });
}
