import type { ChatMessage, ProviderId } from '@shared/runtime-types.ts';
import { getUtf8ByteLength } from '@/lib/runtime.ts';

const STORAGE_KEY = 'pty-remote.messages-cache.v1';
const MAX_CONVERSATIONS = 10;
const MAX_BYTES = 4 * 1024 * 1024; // ~4MB safeguard for localStorage

interface CachedConversationEntry {
  cacheKey: string;
  providerId: ProviderId;
  conversationKey: string | null;
  sessionId: string | null;
  messages: ChatMessage[];
  lastSeq: number | null;
  updatedAt: number;
}

interface MessagesCachePayload {
  order: string[];
  entries: Record<string, CachedConversationEntry>;
}

const emptyCache: MessagesCachePayload = { order: [], entries: {} };

function safeParseCache(raw: string | null): MessagesCachePayload {
  if (!raw) {
    return { ...emptyCache };
  }
  try {
    const parsed = JSON.parse(raw) as MessagesCachePayload;
    if (!parsed || !Array.isArray(parsed.order) || typeof parsed.entries !== 'object') {
      return { ...emptyCache };
    }
    return {
      order: Array.isArray(parsed.order) ? parsed.order.slice() : [],
      entries: parsed.entries ?? {}
    };
  } catch {
    return { ...emptyCache };
  }
}

function readCache(): MessagesCachePayload {
  if (typeof window === 'undefined') {
    return { ...emptyCache };
  }
  return safeParseCache(window.localStorage.getItem(STORAGE_KEY));
}

function writeCache(cache: MessagesCachePayload): void {
  if (typeof window === 'undefined') {
    return;
  }

  let sanitized = {
    order: cache.order.slice(),
    entries: { ...cache.entries }
  };

  // Enforce LRU size
  while (sanitized.order.length > MAX_CONVERSATIONS) {
    const oldest = sanitized.order.pop();
    if (oldest) {
      delete sanitized.entries[oldest];
    }
  }

  // Enforce byte size
  let serialized = JSON.stringify(sanitized);
  while (sanitized.order.length > 0 && getUtf8ByteLength(serialized) > MAX_BYTES) {
    const oldest = sanitized.order.pop();
    if (oldest) {
      delete sanitized.entries[oldest];
    }
    serialized = JSON.stringify(sanitized);
  }

  if (getUtf8ByteLength(serialized) > MAX_BYTES) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, serialized);
}

export function resolveConversationCacheKey(
  providerId: ProviderId | null,
  conversationKey: string | null,
  sessionId: string | null
): string | null {
  if (!providerId) {
    return null;
  }
  if (conversationKey) {
    return `${providerId}:conversation:${conversationKey}`;
  }
  if (sessionId) {
    return `${providerId}:session:${sessionId}`;
  }
  return null;
}

export function readConversationCache(
  providerId: ProviderId | null,
  conversationKey: string | null,
  sessionId: string | null
): CachedConversationEntry | null {
  const cacheKey = resolveConversationCacheKey(providerId, conversationKey, sessionId);
  if (!cacheKey) {
    return null;
  }
  const cache = readCache();
  return cache.entries[cacheKey] ?? null;
}

export function writeConversationCache(entry: Omit<CachedConversationEntry, 'updatedAt' | 'cacheKey'>): void {
  const cacheKey = resolveConversationCacheKey(entry.providerId, entry.conversationKey, entry.sessionId);
  if (!cacheKey) {
    return;
  }
  const cache = readCache();
  cache.entries[cacheKey] = {
    ...entry,
    cacheKey,
    updatedAt: Date.now()
  };
  cache.order = [cacheKey, ...cache.order.filter((key) => key !== cacheKey)];
  writeCache(cache);
}

export function readCachedLastSeq(
  providerId: ProviderId | null,
  conversationKey: string | null,
  sessionId: string | null
): number | null {
  const entry = readConversationCache(providerId, conversationKey, sessionId);
  return entry?.lastSeq ?? null;
}

export function updateCachedLastSeq(
  providerId: ProviderId | null,
  conversationKey: string | null,
  sessionId: string | null,
  lastSeq: number
): void {
  if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) {
    return;
  }
  const cacheKey = resolveConversationCacheKey(providerId, conversationKey, sessionId);
  if (!cacheKey) {
    return;
  }
  const cache = readCache();
  const existing = cache.entries[cacheKey];
  cache.entries[cacheKey] = {
    cacheKey,
    providerId: providerId ?? existing?.providerId ?? 'codex',
    conversationKey: conversationKey ?? existing?.conversationKey ?? null,
    sessionId: sessionId ?? existing?.sessionId ?? null,
    messages: existing?.messages ?? [],
    lastSeq,
    updatedAt: Date.now()
  };
  cache.order = [cacheKey, ...cache.order.filter((key) => key !== cacheKey)];
  writeCache(cache);
}
