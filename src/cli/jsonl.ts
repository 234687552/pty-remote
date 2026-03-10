import path from 'node:path';

import type { ChatMessage } from '../../shared/runtime-types.ts';

interface ClaudeTextContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeJsonlRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ClaudeTextContentBlock[];
    stop_reason?: string | null;
  };
}

type ClaudeMessageContent = string | ClaudeTextContentBlock[] | undefined;

export function resolveClaudeJsonlFilePath(projectRoot: string, sessionId: string, homeDir: string): string {
  const projectSlug = projectRoot.replace(/[\\/]/g, '-');
  return path.join(homeDir, '.claude', 'projects', projectSlug, `${sessionId}.jsonl`);
}

function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  const compacted: ChatMessage[] = [];

  for (const message of messages) {
    if (!message.content.trim()) {
      continue;
    }

    const previous = compacted.at(-1);
    if (previous && previous.role === message.role && previous.content === message.content) {
      compacted[compacted.length - 1] = message;
      continue;
    }

    compacted.push(message);
  }

  return compacted;
}

function extractTextContent(content: ClaudeMessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text?.trimEnd() ?? '')
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function parseClaudeJsonlState(rawText: string): { busy: boolean; messages: ChatMessage[] } {
  const orderedIds: string[] = [];
  const messagesById = new Map<string, ChatMessage>();
  let busy = false;

  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let record: ClaudeJsonlRecord;
    try {
      record = JSON.parse(trimmed) as ClaudeJsonlRecord;
    } catch {
      continue;
    }

    const role = record.message?.role;
    const rawContent = record.message?.content;
    const isToolResultUserMessage =
      Array.isArray(rawContent) && rawContent.some((block) => block && typeof block === 'object' && block.type === 'tool_result');

    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    if (role === 'user' && !isToolResultUserMessage) {
      busy = true;
    }

    if (role === 'assistant') {
      const stopReason = record.message?.stop_reason;
      const hasToolUse =
        Array.isArray(rawContent) && rawContent.some((block) => block && typeof block === 'object' && block.type === 'tool_use');

      if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'max_tokens') {
        busy = false;
      } else if (stopReason === 'tool_use' || hasToolUse || Boolean(extractTextContent(rawContent).trim())) {
        busy = true;
      }
    }

    const content = extractTextContent(rawContent).trim();
    const messageId = role === 'assistant' ? record.message?.id ?? record.uuid : record.uuid;
    if (!messageId) {
      continue;
    }

    const existing = messagesById.get(messageId);
    if (!content && !existing) {
      continue;
    }

    const nextMessage: ChatMessage = {
      id: messageId,
      role,
      content: content || existing?.content || '',
      status: 'complete',
      createdAt: record.timestamp ?? existing?.createdAt ?? new Date().toISOString()
    };

    if (!existing) {
      orderedIds.push(messageId);
    }
    messagesById.set(messageId, nextMessage);
  }

  const messages = compactMessages(
    orderedIds.map((messageId) => messagesById.get(messageId)).filter(Boolean) as ChatMessage[]
  );
  if (busy) {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      lastAssistant.status = 'streaming';
    }
  }

  return { busy, messages };
}
