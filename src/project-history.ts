import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatMessage } from '../shared/runtime-types.ts';
import type { ProjectSessionSummary } from '../shared/protocol.ts';
import { parseClaudeJsonlMessages, resolveClaudeProjectFilesPath } from './cli/jsonl.ts';

const DEFAULT_MAX_SESSIONS = 12;

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

async function summarizeSessionFile(filePath: string, updatedAt: string): Promise<ProjectSessionSummary | null> {
  const rawJsonl = await fs.readFile(filePath, 'utf8');
  const messages = parseClaudeJsonlMessages(rawJsonl);
  const lastUserMessage = getLatestUserTextMessage(messages);
  const preview = getUserMessageText(lastUserMessage);
  if (!preview) {
    return null;
  }

  return {
    sessionId: path.basename(filePath, '.jsonl'),
    title: compactTitle(preview),
    preview,
    updatedAt,
    messageCount: messages.length
  };
}

export async function listProjectSessions(projectRoot: string, maxSessions = DEFAULT_MAX_SESSIONS): Promise<ProjectSessionSummary[]> {
  const projectFilesPath = resolveClaudeProjectFilesPath(projectRoot, os.homedir());
  const normalizedMax = Number.isFinite(maxSessions) ? Math.max(1, Math.min(Math.floor(maxSessions), 50)) : DEFAULT_MAX_SESSIONS;

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

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(async (entry) => {
        const filePath = path.join(projectFilesPath, entry.name);
        const stat = await fs.stat(filePath);
        return {
          filePath,
          updatedAt: stat.mtime.toISOString(),
          updatedAtMs: stat.mtimeMs
        };
      })
  );

  files.sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  const sessions: ProjectSessionSummary[] = [];
  for (const file of files) {
    if (sessions.length >= normalizedMax) {
      break;
    }

    const summary = await summarizeSessionFile(file.filePath, file.updatedAt);
    if (summary) {
      sessions.push(summary);
    }
  }

  return sessions;
}
