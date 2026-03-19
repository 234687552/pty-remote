import path from 'node:path';

import type {
  ChatMessage,
  ChatMessageBlock,
  TextChatMessageBlock,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '@lzdi/pty-remote-protocol/runtime-types.ts';

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
  subtype?: string;
  operation?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  isApiErrorMessage?: boolean;
  retryInMs?: number;
  retryAttempt?: number;
  maxRetries?: number;
  error?: {
    status?: number;
  };
  message?: {
    id?: string;
    role?: string;
    content?: string | ClaudeContentBlock[];
    stop_reason?: string | null;
  };
}

export type ClaudeJsonlRuntimePhase = 'idle' | 'running';

export interface ClaudeJsonlMessagesState {
  orderedIds: string[];
  messagesById: Map<string, ChatMessage>;
  runtimePhase: ClaudeJsonlRuntimePhase;
  activityRevision: number;
  activeApiErrorMessageId: string | null;
  nextSyntheticMessageSequence: number;
}

export function resolveClaudeProjectFilesPath(projectRoot: string, homeDir: string): string {
  const projectSlug = projectRoot.replace(/[\\/]/g, '-');
  return path.join(homeDir, '.claude', 'projects', projectSlug);
}

export function resolveClaudeJsonlFilePath(projectRoot: string, sessionId: string, homeDir: string): string {
  return path.join(resolveClaudeProjectFilesPath(projectRoot, homeDir), `${sessionId}.jsonl`);
}

export function createClaudeJsonlMessagesState(): ClaudeJsonlMessagesState {
  return {
    orderedIds: [],
    messagesById: new Map<string, ChatMessage>(),
    runtimePhase: 'idle',
    activityRevision: 0,
    activeApiErrorMessageId: null,
    nextSyntheticMessageSequence: 1
  };
}

function isTextContentBlock(block: ClaudeContentBlock): block is ClaudeTextContentBlock {
  return block.type === 'text' && 'text' in block && typeof block.text === 'string';
}

function isToolUseContentBlock(block: ClaudeContentBlock): block is ClaudeToolUseContentBlock {
  return block.type === 'tool_use';
}

function isToolResultContentBlock(block: ClaudeContentBlock): block is ClaudeToolResultContentBlock {
  return block.type === 'tool_result';
}

function hasVisibleBlocks(blocks: ChatMessageBlock[]): boolean {
  return blocks.some((block) => {
    switch (block.type) {
      case 'text':
        return Boolean(block.text.trim());
      case 'tool_use':
        return Boolean(block.toolName || block.input);
      case 'tool_result':
        return Boolean(block.content.trim());
      default:
        return false;
    }
  });
}

function blocksEqual(left: ChatMessageBlock[], right: ChatMessageBlock[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((block, index) => {
    const next = right[index];
    if (!next || block.type !== next.type || block.id !== next.id) {
      return false;
    }

    switch (block.type) {
      case 'text':
        return next.type === 'text' && block.text === next.text;
      case 'tool_use':
        return (
          next.type === 'tool_use' &&
          block.toolCallId === next.toolCallId &&
          block.toolName === next.toolName &&
          block.input === next.input
        );
      case 'tool_result':
        return (
          next.type === 'tool_result' &&
          block.toolCallId === next.toolCallId &&
          block.content === next.content &&
          block.isError === next.isError
        );
      default:
        return false;
    }
  });
}

function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  const compacted: ChatMessage[] = [];

  for (const message of messages) {
    if (!hasVisibleBlocks(message.blocks)) {
      continue;
    }

    const previous = compacted.at(-1);
    if (previous && previous.role === message.role && blocksEqual(previous.blocks, message.blocks)) {
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

function resolveRecordMessageId(record: ClaudeJsonlRecord, role: 'user' | 'assistant'): string | null {
  if (role === 'assistant') {
    return record.message?.id ?? record.uuid ?? null;
  }

  return record.uuid ?? null;
}

function createTextBlock(baseId: string, text: string, index = 0): TextChatMessageBlock | null {
  const normalizedText = text.trimEnd();
  if (!normalizedText.trim()) {
    return null;
  }

  return {
    id: `${baseId}:text:${index}`,
    type: 'text',
    text: normalizedText
  };
}

function createToolUseBlock(baseId: string, block: ClaudeToolUseContentBlock, index: number): ToolUseChatMessageBlock {
  return {
    id: block.id ? `tool:${block.id}:use` : `${baseId}:tool_use:${index}`,
    type: 'tool_use',
    toolCallId: block.id,
    toolName: block.name?.trim() || 'unknown',
    input: stringifyUnknown(block.input)
  };
}

function createToolResultBlock(baseId: string, block: ClaudeToolResultContentBlock, index: number): ToolResultChatMessageBlock {
  return {
    id: block.tool_use_id ? `tool:${block.tool_use_id}:result:${index}` : `${baseId}:tool_result:${index}`,
    type: 'tool_result',
    toolCallId: block.tool_use_id,
    content: stringifyUnknown(block.content),
    isError: Boolean(block.is_error)
  };
}

function extractMessageBlocks(record: ClaudeJsonlRecord, baseId: string): ChatMessageBlock[] {
  const rawContent = record.message?.content;

  if (typeof rawContent === 'string') {
    const textBlock = createTextBlock(baseId, rawContent);
    return textBlock ? [textBlock] : [];
  }

  if (!Array.isArray(rawContent)) {
    return [];
  }

  const blocks: ChatMessageBlock[] = [];

  for (const [index, block] of rawContent.entries()) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (isTextContentBlock(block)) {
      const textBlock = createTextBlock(baseId, block.text ?? '', index);
      if (textBlock) {
        blocks.push(textBlock);
      }
      continue;
    }

    if (isToolUseContentBlock(block)) {
      blocks.push(createToolUseBlock(baseId, block, index));
      continue;
    }

    if (isToolResultContentBlock(block)) {
      blocks.push(createToolResultBlock(baseId, block, index));
    }
  }

  return blocks;
}

function deriveMessageStatus(blocks: ChatMessageBlock[]): ChatMessage['status'] {
  if (blocks.some((block) => block.type === 'tool_result' && block.isError)) {
    return 'error';
  }

  return 'complete';
}

function mergeMessageBlocks(existingBlocks: ChatMessageBlock[], nextBlocks: ChatMessageBlock[]): ChatMessageBlock[] {
  if (existingBlocks.length === 0) {
    return nextBlocks;
  }

  if (nextBlocks.length === 0) {
    return existingBlocks;
  }

  const mergedBlocks = existingBlocks.slice();
  const blockIndexById = new Map(mergedBlocks.map((block, index) => [block.id, index]));

  for (const block of nextBlocks) {
    const existingIndex = blockIndexById.get(block.id);
    if (existingIndex === undefined) {
      blockIndexById.set(block.id, mergedBlocks.length);
      mergedBlocks.push(block);
      continue;
    }

    mergedBlocks[existingIndex] = block;
  }

  return mergedBlocks;
}

function upsertMessage(orderedIds: string[], messagesById: Map<string, ChatMessage>, nextMessage: ChatMessage): void {
  const existing = messagesById.get(nextMessage.id);
  const blocks = hasVisibleBlocks(nextMessage.blocks)
    ? mergeMessageBlocks(existing?.blocks ?? [], nextMessage.blocks)
    : existing?.blocks ?? [];

  if (!hasVisibleBlocks(blocks)) {
    return;
  }

  const mergedMessage: ChatMessage = {
    id: nextMessage.id,
    role: nextMessage.role,
    blocks,
    status: nextMessage.status === 'error' ? 'error' : deriveMessageStatus(blocks),
    createdAt: existing?.createdAt || nextMessage.createdAt
  };

  if (!existing) {
    orderedIds.push(nextMessage.id);
  }

  messagesById.set(nextMessage.id, mergedMessage);
}

function removeMessage(orderedIds: string[], messagesById: Map<string, ChatMessage>, messageId: string): void {
  if (!messagesById.has(messageId)) {
    return;
  }

  messagesById.delete(messageId);
  const index = orderedIds.indexOf(messageId);
  if (index >= 0) {
    orderedIds.splice(index, 1);
  }
}

function clearActiveApiErrorMessage(state: ClaudeJsonlMessagesState): void {
  if (!state.activeApiErrorMessageId) {
    return;
  }

  removeMessage(state.orderedIds, state.messagesById, state.activeApiErrorMessageId);
  state.activeApiErrorMessageId = null;
}

function isApiErrorRecord(record: ClaudeJsonlRecord): boolean {
  return record.type === 'system' && record.subtype === 'api_error';
}

function formatApiErrorText(record: ClaudeJsonlRecord): string {
  const status = typeof record.error?.status === 'number' ? String(record.error.status) : 'unknown';
  const lines = [`API Error: ${status} 请求错误(状态码: ${status})`];

  if (typeof record.retryAttempt === 'number' && typeof record.maxRetries === 'number') {
    const retryInSeconds = Math.max(0, Math.round((record.retryInMs ?? 0) / 1000));
    lines.push(`Retrying in ${retryInSeconds} seconds... (attempt ${record.retryAttempt}/${record.maxRetries})`);
  }

  return lines.join('\n');
}

function updateRuntimePhase(
  state: ClaudeJsonlMessagesState,
  record: ClaudeJsonlRecord,
  role: 'user' | 'assistant' | null,
  blocks: ChatMessageBlock[]
): void {
  const markActivity = (nextPhase: ClaudeJsonlRuntimePhase): void => {
    state.runtimePhase = nextPhase;
    state.activityRevision += 1;
  };

  switch (record.type) {
    case 'progress':
      markActivity('running');
      return;
    case 'queue-operation':
      markActivity('running');
      return;
    case 'system':
      if (record.subtype === 'stop_hook_summary') {
        markActivity('idle');
        return;
      }
      if (record.subtype === 'api_error' || record.subtype === 'local_command') {
        markActivity('running');
      }
      return;
    default:
      break;
  }

  if (role === 'user') {
    markActivity('running');
    return;
  }

  if (role !== 'assistant') {
    return;
  }

  const stopReason = record.message?.stop_reason ?? null;
  if (stopReason === 'end_turn') {
    markActivity('idle');
    return;
  }

  if (record.isApiErrorMessage && stopReason === 'stop_sequence') {
    markActivity('idle');
    return;
  }

  if (stopReason === 'tool_use' || blocks.some((block) => block.type === 'tool_use')) {
    markActivity('running');
  }
}

export function applyClaudeJsonlLine(state: ClaudeJsonlMessagesState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  let record: ClaudeJsonlRecord;
  try {
    record = JSON.parse(trimmed) as ClaudeJsonlRecord;
  } catch {
    return false;
  }

  let blocks: ChatMessageBlock[] = [];

  if (isApiErrorRecord(record)) {
    const syntheticMessageId = state.activeApiErrorMessageId ?? `claude:api_error:${state.nextSyntheticMessageSequence++}`;
    state.activeApiErrorMessageId = syntheticMessageId;
    const block = createTextBlock(syntheticMessageId, formatApiErrorText(record));
    if (block) {
      upsertMessage(state.orderedIds, state.messagesById, {
        id: syntheticMessageId,
        role: 'assistant',
        blocks: [block],
        status: 'error',
        createdAt: record.timestamp ?? new Date().toISOString()
      });
      blocks = [block];
    }
  } else if (record.type !== 'summary') {
    clearActiveApiErrorMessage(state);
  }

  const role = record.message?.role === 'user' || record.message?.role === 'assistant' ? record.message.role : null;

  if (role) {
    const messageId = resolveRecordMessageId(record, role);
    if (messageId) {
      blocks = extractMessageBlocks(record, messageId);
      upsertMessage(state.orderedIds, state.messagesById, {
        id: messageId,
        role,
        blocks,
        status: record.isApiErrorMessage ? 'error' : deriveMessageStatus(blocks),
        createdAt: record.timestamp ?? new Date().toISOString()
      });
    }
  }

  updateRuntimePhase(state, record, role, blocks);

  return true;
}

export function materializeClaudeJsonlMessages(state: ClaudeJsonlMessagesState): ChatMessage[] {
  return compactMessages(
    state.orderedIds.map((messageId) => state.messagesById.get(messageId)).filter(Boolean) as ChatMessage[]
  );
}

export function parseClaudeJsonlMessages(rawText: string): ChatMessage[] {
  const state = createClaudeJsonlMessagesState();

  for (const line of rawText.split('\n')) {
    applyClaudeJsonlLine(state, line);
  }

  return materializeClaudeJsonlMessages(state);
}
