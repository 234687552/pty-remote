import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProjectSessionSummary } from '../../shared/protocol.ts';

const DEFAULT_MAX_SESSIONS = 12;
const PENDING_INPUT_LABEL = '待输入';

interface ClaudeHistoryEntry {
  display?: unknown;
  timestamp?: unknown;
  project?: unknown;
  sessionId?: unknown;
}

export interface ClaudeHistoryOptions {
  historyPath?: string;
}

function normalizeMaxSessions(maxSessions: number): number {
  return Number.isFinite(maxSessions) ? Math.max(1, Math.min(Math.floor(maxSessions), 50)) : DEFAULT_MAX_SESSIONS;
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

function coerceTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) {
      return asDate;
    }
  }
  return null;
}

export function resolveClaudeHistoryPath(options: ClaudeHistoryOptions = {}): string {
  return options.historyPath ?? path.join(os.homedir(), '.claude', 'history.jsonl');
}

export async function listClaudeRecentSessions(
  maxSessions = DEFAULT_MAX_SESSIONS,
  options: ClaudeHistoryOptions = {}
): Promise<ProjectSessionSummary[]> {
  const normalizedMax = normalizeMaxSessions(maxSessions);
  const historyPath = resolveClaudeHistoryPath(options);
  const raw = await fs.readFile(historyPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  if (!raw.trim()) {
    return [];
  }

  const summaries = new Map<string, ProjectSessionSummary>();
  const lines = raw.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: ClaudeHistoryEntry;
    try {
      parsed = JSON.parse(line) as ClaudeHistoryEntry;
    } catch {
      continue;
    }

    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
    if (!sessionId || summaries.has(sessionId)) {
      continue;
    }

    const cwd = typeof parsed.project === 'string' ? parsed.project.trim() : '';
    if (!cwd) {
      continue;
    }

    const tsMs = coerceTimestampMs(parsed.timestamp);
    if (tsMs === null) {
      continue;
    }

    const previewSource = typeof parsed.display === 'string' ? parsed.display : '';
    const preview = normalizePreview(previewSource) || PENDING_INPUT_LABEL;
    summaries.set(sessionId, {
      providerId: 'claude',
      sessionId,
      cwd: path.resolve(cwd),
      title: compactTitle(preview),
      preview,
      updatedAt: new Date(tsMs).toISOString(),
      messageCount: 0
    });

    if (summaries.size >= normalizedMax) {
      break;
    }
  }

  return [...summaries.values()].sort((left, right) => {
    const timestampDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return timestampDiff || right.sessionId.localeCompare(left.sessionId);
  });
}
