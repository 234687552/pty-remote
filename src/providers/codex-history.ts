import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProjectSessionSummary } from '../../shared/protocol.ts';
import { parseCodexJsonlMessages } from './codex-jsonl.ts';

const DEFAULT_MAX_SESSIONS = 12;
const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface CodexSessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface SessionMetaPayload {
  id?: string;
  cwd?: string;
  timestamp?: string;
}

interface SessionFileSummary {
  latestUserMessage: string;
  latestTimestamp: string | null;
  messageCount: number;
}

function normalizePreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function compactTitle(text: string): string {
  if (text.length <= 44) {
    return text;
  }
  return `${text.slice(0, 41)}...`;
}

function normalizeMaxSessions(maxSessions: number): number {
  return Number.isFinite(maxSessions) ? Math.max(1, Math.min(Math.floor(maxSessions), 50)) : DEFAULT_MAX_SESSIONS;
}

function resolveSessionIdFromPath(filePath: string): string | null {
  return SESSION_ID_PATTERN.exec(path.basename(filePath))?.[1] ?? null;
}

async function readFirstLine(filePath: string, maxBytes = 64 * 1024): Promise<string> {
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    if (bytesRead <= 0) {
      return '';
    }
    const raw = buffer.toString('utf8', 0, bytesRead);
    return raw.split('\n', 1)[0] ?? '';
  } finally {
    await file.close();
  }
}

async function parseSessionMeta(filePath: string): Promise<SessionMetaPayload | null> {
  try {
    const firstLine = (await readFirstLine(filePath)).trim();
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine) as { type?: string; payload?: SessionMetaPayload };
    if (parsed.type !== 'session_meta' || !parsed.payload) {
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

async function summarizeSessionFile(filePath: string): Promise<SessionFileSummary> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      latestUserMessage: '',
      latestTimestamp: null,
      messageCount: 0
    };
  }

  const parsed = parseCodexJsonlMessages(raw);
  let latestUserMessage = '';
  let latestTimestamp: string | null = null;

  for (const message of parsed.messages) {
    latestTimestamp = message.createdAt;
    if (message.role !== 'user') {
      continue;
    }

    const normalized = normalizePreview(
      message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
    );
    if (normalized) {
      latestUserMessage = normalized;
    }
  }

  return {
    latestUserMessage,
    latestTimestamp,
    messageCount: parsed.messages.filter((message) => message.blocks.some((block) => block.type !== 'tool_result')).length
  };
}

async function collectSessionFiles(rootPath: string): Promise<string[]> {
  const collected: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const nextPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(nextPath);
          return;
        }
        if (entry.isFile() && nextPath.endsWith('.jsonl')) {
          collected.push(nextPath);
        }
      })
    );
  }

  await walk(rootPath);
  return collected;
}

async function findSessionFileById(rootPath: string, sessionId: string): Promise<string | null> {
  const normalizedSuffix = `${sessionId.trim().toLowerCase()}.jsonl`;
  if (!normalizedSuffix || normalizedSuffix === '.jsonl') {
    return null;
  }

  async function walk(currentPath: string): Promise<string | null> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isFile()) {
        if (entry.name.toLowerCase().endsWith(normalizedSuffix)) {
          return nextPath;
        }
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }

      const found = await walk(nextPath);
      if (found) {
        return found;
      }
    }

    return null;
  }

  return walk(rootPath);
}

async function readSessionIndex(indexPath: string): Promise<CodexSessionIndexEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const entries: CodexSessionIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as CodexSessionIndexEntry;
      if (parsed.id) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines from local index.
    }
  }

  return entries.sort((left, right) => {
    const diff = new Date(right.updated_at ?? 0).getTime() - new Date(left.updated_at ?? 0).getTime();
    if (diff !== 0) {
      return diff;
    }
    return (right.id ?? '').localeCompare(left.id ?? '');
  });
}

function buildSessionFileMap(filePaths: string[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const filePath of filePaths) {
    const sessionId = resolveSessionIdFromPath(filePath);
    if (!sessionId || byId.has(sessionId)) {
      continue;
    }
    byId.set(sessionId, filePath);
  }
  return byId;
}

export interface CodexHistoryOptions {
  indexPath?: string;
  sessionsRootPath?: string;
}

export interface CodexSessionLookupResult {
  filePath: string;
  sessionId: string;
  timestamp: string | null;
}

function resolveHistoryPaths(options: CodexHistoryOptions): { indexPath: string; sessionsRootPath: string } {
  const codexRoot = path.join(os.homedir(), '.codex');
  return {
    indexPath: options.indexPath ?? path.join(codexRoot, 'session_index.jsonl'),
    sessionsRootPath: options.sessionsRootPath ?? path.join(codexRoot, 'sessions')
  };
}

export async function findCodexSessionFile(sessionId: string, options: CodexHistoryOptions = {}): Promise<string | null> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return null;
  }

  const { sessionsRootPath } = resolveHistoryPaths(options);
  return findSessionFileById(sessionsRootPath, normalized);
}

export async function findLatestCodexSessionForCwdSince(
  projectRoot: string,
  sinceMs: number,
  options: CodexHistoryOptions = {}
): Promise<CodexSessionLookupResult | null> {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const { indexPath, sessionsRootPath } = resolveHistoryPaths(options);
  const toleranceMs = 15_000;
  const minTimestampMs = Math.max(0, sinceMs - toleranceMs);
  const indexEntries = await readSessionIndex(indexPath);

  for (const entry of indexEntries) {
    const updatedAtMs = new Date(entry.updated_at ?? 0).getTime();
    if (Number.isFinite(updatedAtMs) && updatedAtMs < minTimestampMs) {
      break;
    }

    const filePath = await findSessionFileById(sessionsRootPath, entry.id);
    if (!filePath) {
      continue;
    }

    const sessionMeta = await parseSessionMeta(filePath);
    if (!sessionMeta?.id || !sessionMeta.cwd || path.resolve(sessionMeta.cwd) !== normalizedProjectRoot) {
      continue;
    }

    const timestampMs = new Date(sessionMeta.timestamp ?? entry.updated_at ?? 0).getTime();
    if (Number.isFinite(timestampMs) && timestampMs < minTimestampMs) {
      continue;
    }

    return {
      filePath,
      sessionId: sessionMeta.id,
      timestamp: sessionMeta.timestamp ?? entry.updated_at ?? null
    };
  }

  return null;
}

export async function listCodexProjectSessions(projectRoot: string, maxSessions = DEFAULT_MAX_SESSIONS, options: CodexHistoryOptions = {}): Promise<ProjectSessionSummary[]> {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const normalizedMax = normalizeMaxSessions(maxSessions);
  const { indexPath, sessionsRootPath } = resolveHistoryPaths(options);
  const indexEntries = await readSessionIndex(indexPath);
  const sessionFiles = await collectSessionFiles(sessionsRootPath);
  const fileBySessionId = buildSessionFileMap(sessionFiles);
  const results: ProjectSessionSummary[] = [];

  for (const entry of indexEntries) {
    const filePath = fileBySessionId.get(entry.id);
    if (!filePath) {
      continue;
    }

    const sessionMeta = await parseSessionMeta(filePath);
    if (!sessionMeta?.cwd || path.resolve(sessionMeta.cwd) !== normalizedProjectRoot) {
      continue;
    }

    const sessionSummary = await summarizeSessionFile(filePath);
    const titleSource = normalizePreview(entry.thread_name ?? '') || sessionSummary.latestUserMessage || entry.id;
    const updatedAt = sessionSummary.latestTimestamp ?? entry.updated_at ?? new Date().toISOString();
    results.push({
      providerId: 'codex',
      sessionId: entry.id,
      title: compactTitle(titleSource),
      preview: titleSource,
      updatedAt,
      messageCount: sessionSummary.messageCount
    });

    if (results.length >= normalizedMax) {
      break;
    }
  }

  return results;
}
