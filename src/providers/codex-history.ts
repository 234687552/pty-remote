import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProjectSessionSummary } from '../../shared/protocol.ts';

const DEFAULT_MAX_SESSIONS = 12;
const DEFAULT_HISTORY_TAIL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_HISTORY_TAIL_CHUNK_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const PENDING_INPUT_LABEL = '待输入';

interface SessionMetaPayload {
  id?: string;
  cwd?: string;
}

interface HistoryEntry {
  sessionId: string;
  tsMs: number;
  text: string;
  filePath: string;
  cwd: string;
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

async function walkSessionFiles(
  rootPath: string,
  onFile: (filePath: string, fileName: string) => Promise<boolean | void>
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const nextPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const shouldStop = await walkSessionFiles(nextPath, onFile);
      if (shouldStop) {
        return true;
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const shouldStop = await onFile(nextPath, entry.name);
    if (shouldStop) {
      return true;
    }
  }

  return false;
}

function extractSessionIdFromName(fileName: string): string | null {
  return SESSION_ID_PATTERN.exec(fileName)?.[1] ?? null;
}

async function buildSessionFileIndex(rootPath: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  await walkSessionFiles(rootPath, async (filePath, fileName) => {
    const sessionId = extractSessionIdFromName(fileName);
    if (!sessionId || index.has(sessionId)) {
      return false;
    }
    index.set(sessionId, filePath);
    return false;
  });
  return index;
}

async function findSessionFileById(rootPath: string, sessionId: string): Promise<string | null> {
  const normalizedSuffix = `${sessionId.trim().toLowerCase()}.jsonl`;
  if (!normalizedSuffix || normalizedSuffix === '.jsonl') {
    return null;
  }

  let found: string | null = null;
  await walkSessionFiles(rootPath, async (filePath, fileName) => {
    if (fileName.toLowerCase().endsWith(normalizedSuffix)) {
      found = filePath;
      return true;
    }
    return false;
  });

  return found;
}

async function resolveSessionFilePath(
  sessionId: string,
  index: Map<string, string>,
  sessionsRootPath: string
): Promise<string | null> {
  const fromIndex = index.get(sessionId);
  if (fromIndex) {
    return fromIndex;
  }
  return findSessionFileById(sessionsRootPath, sessionId);
}

function coerceHistoryTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed > 1e12 ? parsed : parsed * 1000;
    }
  }
  return null;
}

async function readHistoryTail(
  historyPath: string,
  sessionsRootPath: string,
  maxSessions: number,
  minTimestampMs?: number,
  projectRoot?: string
): Promise<HistoryEntry[]> {
  const normalizedProjectRoot = projectRoot ? path.resolve(projectRoot) : null;
  const fileIndex = await buildSessionFileIndex(sessionsRootPath);
  const results: HistoryEntry[] = [];
  const seen = new Set<string>();

  let file: FileHandle | null = null;
  try {
    file = await fs.open(historyPath, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    let position = stat.size;
    let scanned = 0;
    let leftover = '';
    let stop = false;

    while (position > 0 && results.length < maxSessions && scanned < DEFAULT_HISTORY_TAIL_MAX_BYTES && !stop) {
      const readSize = Math.min(DEFAULT_HISTORY_TAIL_CHUNK_BYTES, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await file.read(buffer, 0, readSize, position);
      if (bytesRead <= 0) {
        break;
      }
      scanned += bytesRead;

      const chunk = buffer.toString('utf8', 0, bytesRead) + leftover;
      const lines = chunk.split('\n');
      if (position > 0) {
        leftover = lines.shift() ?? '';
      } else {
        leftover = '';
      }

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: { session_id?: string; ts?: unknown; text?: unknown };
        try {
          parsed = JSON.parse(line) as { session_id?: string; ts?: unknown; text?: unknown };
        } catch {
          continue;
        }

        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
        if (!sessionId || seen.has(sessionId)) {
          continue;
        }

        const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        const tsMs = coerceHistoryTimestampMs(parsed.ts);
        if (tsMs === null) {
          continue;
        }
        if (minTimestampMs !== undefined && tsMs < minTimestampMs) {
          stop = true;
          break;
        }

        const filePath = await resolveSessionFilePath(sessionId, fileIndex, sessionsRootPath);
        if (!filePath) {
          continue;
        }

        const sessionMeta = await parseSessionMeta(filePath);
        const cwd = typeof sessionMeta?.cwd === 'string' ? sessionMeta.cwd.trim() : '';
        if (!cwd) {
          continue;
        }
        const normalizedCwd = path.resolve(cwd);
        if (normalizedProjectRoot && normalizedCwd !== normalizedProjectRoot) {
          continue;
        }

        if (sessionMeta?.id && sessionMeta.id !== sessionId) {
          continue;
        }

        results.push({
          sessionId,
          tsMs,
          text,
          filePath,
          cwd: normalizedCwd
        });
        seen.add(sessionId);
        if (results.length >= maxSessions) {
          break;
        }
      }
    }

    return results;
  } finally {
    await file.close();
  }
}

export interface CodexHistoryOptions {
  sessionsRootPath?: string;
  historyPath?: string;
}

export interface CodexSessionLookupResult {
  filePath: string;
  sessionId: string;
  timestamp: string | null;
}

export function resolveCodexHistoryPaths(options: CodexHistoryOptions): { historyPath: string; sessionsRootPath: string } {
  const codexRoot = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return {
    historyPath: options.historyPath ?? path.join(codexRoot, 'history.jsonl'),
    sessionsRootPath: options.sessionsRootPath ?? path.join(codexRoot, 'sessions')
  };
}

export async function findCodexSessionFile(sessionId: string, options: CodexHistoryOptions = {}): Promise<string | null> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return null;
  }

  const { sessionsRootPath } = resolveCodexHistoryPaths(options);
  return findSessionFileById(sessionsRootPath, normalized);
}

export async function findLatestCodexSessionForCwdSince(
  projectRoot: string,
  sinceMs: number,
  options: CodexHistoryOptions = {}
): Promise<CodexSessionLookupResult | null> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await fs.realpath(resolvedProjectRoot).catch(() => resolvedProjectRoot);
  const { historyPath, sessionsRootPath } = resolveCodexHistoryPaths(options);
  const toleranceMs = 15_000;
  const minTimestampMs = Math.max(0, sinceMs - toleranceMs);

  const matches = await readHistoryTail(historyPath, sessionsRootPath, 1, minTimestampMs, canonicalProjectRoot);
  if (matches.length === 0) {
    return null;
  }

  const match = matches[0];
  return {
    filePath: match.filePath,
    sessionId: match.sessionId,
    timestamp: new Date(match.tsMs).toISOString()
  };
}

export async function listCodexRecentSessions(
  maxSessions = DEFAULT_MAX_SESSIONS,
  options: CodexHistoryOptions = {}
): Promise<ProjectSessionSummary[]> {
  const normalizedMax = normalizeMaxSessions(maxSessions);
  const { historyPath, sessionsRootPath } = resolveCodexHistoryPaths(options);

  const matches = await readHistoryTail(historyPath, sessionsRootPath, normalizedMax);
  return matches
    .map((entry) => {
      const preview = normalizePreview(entry.text) || PENDING_INPUT_LABEL;
      return {
        providerId: 'codex',
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: compactTitle(preview),
        preview,
        updatedAt: new Date(entry.tsMs).toISOString(),
        messageCount: 0
      } satisfies ProjectSessionSummary;
    })
    .sort((left, right) => {
      const timestampDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      return timestampDiff || right.sessionId.localeCompare(left.sessionId);
    });
}

export async function listCodexProjectSessions(
  projectRoot: string,
  maxSessions = DEFAULT_MAX_SESSIONS,
  options: CodexHistoryOptions = {}
): Promise<ProjectSessionSummary[]> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await fs.realpath(resolvedProjectRoot).catch(() => resolvedProjectRoot);
  const normalizedMax = normalizeMaxSessions(maxSessions);
  const { historyPath, sessionsRootPath } = resolveCodexHistoryPaths(options);

  const matches = await readHistoryTail(historyPath, sessionsRootPath, normalizedMax, undefined, canonicalProjectRoot);
  return matches
    .map((entry) => {
      const preview = normalizePreview(entry.text) || PENDING_INPUT_LABEL;
      return {
        providerId: 'codex',
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: compactTitle(preview),
        preview,
        updatedAt: new Date(entry.tsMs).toISOString(),
        messageCount: 0
      } satisfies ProjectSessionSummary;
    })
    .sort((left, right) => {
      const timestampDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      return timestampDiff || right.sessionId.localeCompare(left.sessionId);
    });
}
