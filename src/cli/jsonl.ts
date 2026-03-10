import path from 'node:path';

import type { ChatMessage } from '../../shared/runtime-types.ts';

interface ClaudeTextContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeToolUseContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeToolResultContentBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

type ClaudeContentBlock = ClaudeTextContentBlock | ClaudeToolUseContentBlock | ClaudeToolResultContentBlock;

interface ClaudeJsonlRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ClaudeContentBlock[];
    stop_reason?: string | null;
  };
}

type ClaudeMessageContent = string | ClaudeContentBlock[] | undefined;

interface ParsedMessageEntry {
  id: string;
  role: 'user' | 'assistant';
  type: ChatMessage['type'];
  content: string;
  status: ChatMessage['status'];
  createdAt: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

export function resolveClaudeJsonlFilePath(projectRoot: string, sessionId: string, homeDir: string): string {
  const projectSlug = projectRoot.replace(/[\\/]/g, '-');
  return path.join(homeDir, '.claude', 'projects', projectSlug, `${sessionId}.jsonl`);
}

function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  const compacted: ChatMessage[] = [];

  for (const message of messages) {
    const hasVisibleContent =
      message.type === 'tool-invocation'
        ? Boolean(message.toolName || message.toolInput || message.toolResult)
        : Boolean(message.content.trim());

    if (!hasVisibleContent) {
      continue;
    }

    const previous = compacted.at(-1);
    if (
      previous &&
      previous.role === message.role &&
      previous.type === message.type &&
      previous.content === message.content &&
      previous.toolCallId === message.toolCallId &&
      previous.toolName === message.toolName &&
      previous.toolInput === message.toolInput &&
      previous.toolResult === message.toolResult
    ) {
      compacted[compacted.length - 1] = message;
      continue;
    }

    compacted.push(message);
  }

  return compacted;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
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

function resolveToolInvocationMessageId(
  record: ClaudeJsonlRecord,
  block: ClaudeToolUseContentBlock | ClaudeToolResultContentBlock,
  index: number
): string | null {
  if ('id' in block && block.id) {
    return `tool:${block.id}`;
  }

  if ('tool_use_id' in block && block.tool_use_id) {
    return `tool:${block.tool_use_id}`;
  }

  if (!record.uuid) {
    return null;
  }

  return `${record.uuid}:tool:${index}`;
}

function flushTextEntry(entries: ParsedMessageEntry[], record: ClaudeJsonlRecord, role: 'user' | 'assistant', textParts: string[]): void {
  const content = textParts.map((part) => part.trimEnd()).filter(Boolean).join('\n\n').trim();
  if (!content) {
    return;
  }

  const baseId = role === 'assistant' ? record.message?.id ?? record.uuid : record.uuid;
  if (!baseId) {
    return;
  }

  entries.push({
    id: `${baseId}:text`,
    role,
    type: 'markdown',
    content,
    status: 'complete',
    createdAt: record.timestamp ?? new Date().toISOString()
  });
}

function extractMessageEntries(record: ClaudeJsonlRecord): ParsedMessageEntry[] {
  const role = record.message?.role;
  if (role !== 'user' && role !== 'assistant') {
    return [];
  }

  const rawContent = record.message?.content;
  if (typeof rawContent === 'string') {
    const content = rawContent.trim();
    if (!content) {
      return [];
    }

    const baseId = role === 'assistant' ? record.message?.id ?? record.uuid : record.uuid;
    if (!baseId) {
      return [];
    }

    return [
      {
        id: `${baseId}:text`,
        role,
        type: 'markdown',
        content,
        status: 'complete',
        createdAt: record.timestamp ?? new Date().toISOString()
      }
    ];
  }

  if (!Array.isArray(rawContent)) {
    return [];
  }

  const entries: ParsedMessageEntry[] = [];
  const textParts: string[] = [];

  for (const [index, block] of rawContent.entries()) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }

    flushTextEntry(entries, record, role, textParts);
    textParts.length = 0;

    if (block.type === 'tool_use' && role === 'assistant') {
      const messageId = resolveToolInvocationMessageId(record, block, index);
      if (!messageId) {
        continue;
      }

      const toolInput = stringifyUnknown(block.input);
      entries.push({
        id: messageId,
        role: 'assistant',
        type: 'tool-invocation',
        content: '',
        status: 'streaming',
        createdAt: record.timestamp ?? new Date().toISOString(),
        toolCallId: block.id,
        toolName: block.name || 'unknown',
        toolInput
      });
      continue;
    }

    if (block.type === 'tool_result') {
      const messageId = resolveToolInvocationMessageId(record, block, index);
      if (!messageId) {
        continue;
      }

      entries.push({
        id: messageId,
        role: 'assistant',
        type: 'tool-invocation',
        content: '',
        status: block.is_error ? 'error' : 'complete',
        createdAt: record.timestamp ?? new Date().toISOString(),
        toolCallId: block.tool_use_id,
        toolResult: stringifyUnknown(block.content)
      });
    }
  }

  flushTextEntry(entries, record, role, textParts);
  return entries;
}

function upsertMessage(orderedIds: string[], messagesById: Map<string, ChatMessage>, entry: ParsedMessageEntry): void {
  const existing = messagesById.get(entry.id);
  const hasVisibleContent =
    entry.type === 'tool-invocation'
      ? Boolean(entry.toolName || entry.toolInput || entry.toolResult || existing?.toolName || existing?.toolInput || existing?.toolResult)
      : Boolean(entry.content || existing?.content);

  if (!hasVisibleContent && !existing) {
    return;
  }

  const nextMessage: ChatMessage = {
    id: entry.id,
    role: entry.role,
    type: entry.type,
    content: entry.content || existing?.content || '',
    status: entry.status,
    createdAt: existing?.createdAt || entry.createdAt || new Date().toISOString(),
    toolCallId: entry.toolCallId ?? existing?.toolCallId,
    toolName: entry.toolName ?? existing?.toolName,
    toolInput: entry.toolInput ?? existing?.toolInput,
    toolResult: entry.toolResult ?? existing?.toolResult
  };

  if (!existing) {
    orderedIds.push(entry.id);
  }

  messagesById.set(entry.id, nextMessage);
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

    for (const entry of extractMessageEntries(record)) {
      upsertMessage(orderedIds, messagesById, entry);
    }
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
