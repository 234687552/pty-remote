import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatMessage } from '../shared/runtime-types.ts';
import type { ProjectSessionSummary } from '../shared/protocol.ts';
import { parseClaudeJsonlMessages, resolveClaudeProjectFilesPath } from './cli/jsonl.ts';

const DEFAULT_MAX_SESSIONS = 12;

interface SessionFileEntry {
  filePath: string;
  sessionId: string;
  updatedAtMs: number;
}

function normalizePreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getUserMessageText(message: ChatMessage | undefined): string {
  if (!message) {
    return '';
  }

  return normalizePreview(
    message.blocks
      .map((block) => {
        if (block.type === 'text') {
          return block.text;
        }
        return '';
      })
      .join(' ')
  );
}

function getLatestUserTextMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === 'user' && Boolean(getUserMessageText(message)));
}

function getMessagePreview(message: ChatMessage | undefined): string {
  if (!message) {
    return '';
  }

  const text = message.blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      if (block.type === 'tool_use') {
        return `${block.toolName} ${block.input}`;
      }
      return block.content;
    })
    .join(' ');

  return normalizePreview(text);
}

function compactTitle(text: string): string {
  if (text.length <= 44) {
    return text;
  }

  return `${text.slice(0, 41)}...`;
}

async function summarizeSessionFile(filePath: string): Promise<ProjectSessionSummary | null> {
  const rawJsonl = await fs.readFile(filePath, 'utf8');
  const messages = parseClaudeJsonlMessages(rawJsonl);
  const lastUserMessage = getLatestUserTextMessage(messages);
  const preview = getUserMessageText(lastUserMessage);
  const updatedAt = lastUserMessage?.createdAt ?? null;
  if (!preview || !updatedAt) {
    return null;
  }

  return {
    providerId: 'claude',
    sessionId: path.basename(filePath, '.jsonl'),
    title: compactTitle(preview),
    preview,
    updatedAt,
    messageCount: messages.length
  };
}

async function listSessionFiles(projectFilesPath: string): Promise<SessionFileEntry[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectFilesPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const sessionFiles: SessionFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const filePath = path.join(projectFilesPath, entry.name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (!stat.isFile()) {
      continue;
    }

    sessionFiles.push({
      filePath,
      sessionId: path.basename(entry.name, '.jsonl'),
      updatedAtMs: stat.mtimeMs
    } satisfies SessionFileEntry);
  }

  return sessionFiles.sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs || right.sessionId.localeCompare(left.sessionId)
  );
}

export async function listProjectSessions(projectRoot: string, maxSessions = DEFAULT_MAX_SESSIONS): Promise<ProjectSessionSummary[]> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await fs.realpath(resolvedProjectRoot).catch(() => resolvedProjectRoot);
  const projectFilesPath = resolveClaudeProjectFilesPath(canonicalProjectRoot, os.homedir());
  const normalizedMax = Number.isFinite(maxSessions) ? Math.max(1, Math.min(Math.floor(maxSessions), 50)) : DEFAULT_MAX_SESSIONS;
  const sessionFiles = await listSessionFiles(projectFilesPath);
  const sessions: ProjectSessionSummary[] = [];

  for (const entry of sessionFiles) {
    let summary: ProjectSessionSummary | null;
    try {
      summary = await summarizeSessionFile(entry.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (!summary) {
      continue;
    }

    sessions.push(summary);
    if (sessions.length >= normalizedMax) {
      break;
    }
  }

  return sessions.sort((left, right) => {
    const timestampDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return timestampDiff || right.sessionId.localeCompare(left.sessionId);
  });
}
