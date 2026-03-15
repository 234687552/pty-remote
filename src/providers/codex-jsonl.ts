import type {
  ChatMessage,
  ChatMessageBlock,
  TextChatMessageBlock,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '../../shared/runtime-types.ts';

interface CodexTextContentBlock {
  type?: string;
  text?: string;
}

interface CodexResponseItemPayload {
  type?: string;
  role?: string;
  phase?: string;
  content?: string | CodexTextContentBlock[];
  arguments?: string;
  input?: unknown;
  output?: unknown;
  call_id?: string;
  name?: string;
  status?: string;
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
    pattern?: string;
  } | Record<string, unknown>;
}

interface CodexEventMsgPayload {
  type?: string;
  message?: string;
  text?: string;
  phase?: string;
}

interface CodexJsonlRecord {
  timestamp?: string;
  type?: string;
  payload?: CodexResponseItemPayload | CodexEventMsgPayload;
}

export type CodexJsonlRuntimePhase = 'idle' | 'running';

export interface CodexJsonlMessagesState {
  orderedIds: string[];
  messagesById: Map<string, ChatMessage>;
  runtimePhase: CodexJsonlRuntimePhase;
  activityRevision: number;
  messageSequence: number;
  seenAssistantTextKeys: Set<string>;
}

export function createCodexJsonlMessagesState(): CodexJsonlMessagesState {
  return {
    orderedIds: [],
    messagesById: new Map<string, ChatMessage>(),
    runtimePhase: 'idle',
    activityRevision: 0,
    messageSequence: 0,
    seenAssistantTextKeys: new Set<string>()
  };
}

function normalizeAssistantText(text: string): string {
  return text.trim();
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createStableTextMessageId(kind: string, timestamp: string | undefined, text: string, sequence: number): string {
  const normalized = text.trim();
  const digest = hashText(normalized);
  const normalizedTimestamp = timestamp?.trim();
  if (normalizedTimestamp) {
    return `${kind}:${normalizedTimestamp}:${digest}`;
  }
  return `${kind}:seq:${sequence}:${digest}`;
}

function rememberAssistantText(
  state: CodexJsonlMessagesState,
  timestamp: string | undefined,
  text: string
): boolean {
  const normalizedText = normalizeAssistantText(text);
  if (!normalizedText) {
    return false;
  }

  const parsedTimestampMs = new Date(timestamp ?? '').getTime();
  const timestampBucket = Number.isFinite(parsedTimestampMs)
    ? String(Math.floor(parsedTimestampMs / 1_000))
    : `seq:${Math.floor(state.messageSequence / 4)}`;
  const dedupeKey = `${timestampBucket}\u0000${normalizedText}`;
  if (state.seenAssistantTextKeys.has(dedupeKey)) {
    return false;
  }

  state.seenAssistantTextKeys.add(dedupeKey);
  return true;
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

function normalizeCreatedAt(timestamp: string | undefined, sequence: number): string {
  const parsed = new Date(timestamp ?? '').getTime();
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date(sequence * 1_000).toISOString();
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

function createTextBlock(baseId: string, text: string, index = 0): TextChatMessageBlock | null {
  const normalized = text.trimEnd();
  if (!normalized.trim()) {
    return null;
  }

  return {
    id: `${baseId}:text:${index}`,
    type: 'text',
    text: normalized
  };
}

function createToolUseBlock(callId: string, toolName: string, input: string): ToolUseChatMessageBlock {
  return {
    id: `tool:${callId}:use`,
    type: 'tool_use',
    toolCallId: callId,
    toolName: toolName.trim() || 'unknown',
    input
  };
}

function createToolResultBlock(callId: string, content: string, isError: boolean): ToolResultChatMessageBlock {
  return {
    id: `tool:${callId}:result`,
    type: 'tool_result',
    toolCallId: callId,
    content,
    isError
  };
}

function getWebSearchQuery(action: CodexResponseItemPayload['action']): string {
  if (!action || typeof action !== 'object') {
    return '';
  }

  const normalizedAction = action as {
    type?: string;
    query?: string;
    queries?: string[];
  };
  if (normalizedAction.type !== 'search') {
    return '';
  }

  if (typeof normalizedAction.query === 'string' && normalizedAction.query.trim()) {
    return normalizedAction.query.trim();
  }

  if (Array.isArray(normalizedAction.queries)) {
    const firstQuery = normalizedAction.queries.find((query) => typeof query === 'string' && query.trim());
    return firstQuery?.trim() ?? '';
  }

  return '';
}

function mergeMessageBlocks(existingBlocks: ChatMessageBlock[], nextBlocks: ChatMessageBlock[]): ChatMessageBlock[] {
  if (existingBlocks.length === 0) {
    return nextBlocks;
  }

  if (nextBlocks.length === 0) {
    return existingBlocks;
  }

  const merged = existingBlocks.slice();
  const blockIndexById = new Map(merged.map((block, index) => [block.id, index]));

  for (const block of nextBlocks) {
    const existingIndex = blockIndexById.get(block.id);
    if (existingIndex === undefined) {
      blockIndexById.set(block.id, merged.length);
      merged.push(block);
      continue;
    }
    merged[existingIndex] = block;
  }

  return merged;
}

function deriveMessageStatus(
  blocks: ChatMessageBlock[],
  runtimePhase: CodexJsonlRuntimePhase
): ChatMessage['status'] {
  if (blocks.some((block) => block.type === 'tool_result' && block.isError)) {
    return 'error';
  }

  const hasToolUse = blocks.some((block) => block.type === 'tool_use');
  const hasToolResult = blocks.some((block) => block.type === 'tool_result');
  if (hasToolUse && !hasToolResult && runtimePhase === 'running') {
    return 'streaming';
  }

  return 'complete';
}

export function refreshCodexJsonlMessageStatuses(state: CodexJsonlMessagesState): void {
  for (const [messageId, message] of state.messagesById.entries()) {
    const nextStatus = deriveMessageStatus(message.blocks, state.runtimePhase);
    if (message.status === nextStatus) {
      continue;
    }
    state.messagesById.set(messageId, {
      ...message,
      status: nextStatus
    });
  }
}

function upsertMessage(state: CodexJsonlMessagesState, nextMessage: ChatMessage): void {
  const existing = state.messagesById.get(nextMessage.id);
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
    status: deriveMessageStatus(blocks, state.runtimePhase),
    createdAt: existing?.createdAt ?? nextMessage.createdAt
  };

  if (!existing) {
    state.orderedIds.push(nextMessage.id);
  }

  state.messagesById.set(nextMessage.id, mergedMessage);
  state.activityRevision += 1;
}

function extractTextBlocks(content: string | CodexTextContentBlock[] | undefined, baseId: string): ChatMessageBlock[] {
  if (typeof content === 'string') {
    const textBlock = createTextBlock(baseId, content);
    return textBlock ? [textBlock] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ChatMessageBlock[] = [];
  for (const [index, block] of content.entries()) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      const textBlock = createTextBlock(baseId, block.text, index);
      if (textBlock) {
        blocks.push(textBlock);
      }
    }
  }

  return blocks;
}

function applyEventMsg(state: CodexJsonlMessagesState, payload: CodexEventMsgPayload | undefined, timestamp: string | undefined): void {
  const payloadType = payload?.type;
  if (payloadType === 'user_message') {
    const sequence = state.messageSequence++;
    const messageText = payload?.message ?? '';
    const messageId = createStableTextMessageId('codex:user', timestamp, messageText, sequence);
    const textBlock = createTextBlock(messageId, messageText);
    if (!textBlock) {
      return;
    }

    upsertMessage(state, {
      id: messageId,
      role: 'user',
      blocks: [textBlock],
      status: 'complete',
      createdAt: normalizeCreatedAt(timestamp, sequence)
    });
    return;
  }

  if (payloadType === 'agent_reasoning') {
    const reasoningText = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!reasoningText) {
      return;
    }
    if (!rememberAssistantText(state, timestamp, reasoningText)) {
      return;
    }

    const sequence = state.messageSequence++;
    const messageId = createStableTextMessageId('codex:assistant_reasoning', timestamp, reasoningText, sequence);
    const textBlock = createTextBlock(messageId, reasoningText);
    if (!textBlock) {
      return;
    }

    upsertMessage(state, {
      id: messageId,
      role: 'assistant',
      blocks: [textBlock],
      status: 'complete',
      createdAt: normalizeCreatedAt(timestamp, sequence)
    });
    return;
  }

  if (payloadType === 'agent_message') {
    const messageText = typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (!messageText) {
      return;
    }
    if (!rememberAssistantText(state, timestamp, messageText)) {
      return;
    }

    const sequence = state.messageSequence++;
    const messageId = createStableTextMessageId('codex:assistant_text', timestamp, messageText, sequence);
    const textBlock = createTextBlock(messageId, messageText);
    if (!textBlock) {
      return;
    }

    upsertMessage(state, {
      id: messageId,
      role: 'assistant',
      blocks: [textBlock],
      status: 'complete',
      createdAt: normalizeCreatedAt(timestamp, sequence)
    });
    return;
  }

  let nextPhase: CodexJsonlRuntimePhase | null = null;

  if (payloadType === 'task_started') {
    nextPhase = 'running';
  } else if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
    nextPhase = 'idle';
  }

  if (!nextPhase || nextPhase === state.runtimePhase) {
    return;
  }

  state.runtimePhase = nextPhase;
  state.activityRevision += 1;
  refreshCodexJsonlMessageStatuses(state);
}

function applyResponseItem(
  state: CodexJsonlMessagesState,
  payload: CodexResponseItemPayload | undefined,
  timestamp: string | undefined
): void {
  const payloadType = payload?.type;
  if (!payloadType) {
    return;
  }

  if (payloadType === 'message') {
    if (payload?.role !== 'assistant') {
      return;
    }

    const sequence = state.messageSequence++;
    const provisionalMessageId = `codex:assistant:${sequence}`;
    const blocks = extractTextBlocks(payload.content, provisionalMessageId);
    if (blocks.length === 0) {
      return;
    }
    const messageText = blocks
      .filter((block): block is TextChatMessageBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!rememberAssistantText(state, timestamp, messageText)) {
      return;
    }

    const stableMessageId = createStableTextMessageId('codex:assistant_text', timestamp, messageText, sequence);
    const stableBlocks = extractTextBlocks(payload.content, stableMessageId);
    if (stableBlocks.length === 0) {
      return;
    }

    upsertMessage(state, {
      id: stableMessageId,
      role: 'assistant',
      blocks: stableBlocks,
      status: 'complete',
      createdAt: normalizeCreatedAt(timestamp, sequence)
    });
    return;
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const callId = payload.call_id?.trim();
    if (!callId) {
      return;
    }

    const rawInput = payloadType === 'custom_tool_call' ? payload.input : payload.arguments;
    upsertMessage(state, {
      id: `tool:${callId}`,
      role: 'assistant',
      blocks: [createToolUseBlock(callId, payload.name ?? 'unknown', stringifyUnknown(rawInput))],
      status: 'streaming',
      createdAt: normalizeCreatedAt(timestamp, state.messageSequence++)
    });
    return;
  }

  if (payloadType === 'web_search_call') {
    const query = getWebSearchQuery(payload.action);
    if (!query) {
      return;
    }

    const sequence = state.messageSequence++;
    const callId = `web_search_${sequence}`;
    upsertMessage(state, {
      id: `tool:${callId}`,
      role: 'assistant',
      blocks: [createToolUseBlock(callId, 'web_search', query)],
      status: 'complete',
      createdAt: normalizeCreatedAt(timestamp, sequence)
    });
    return;
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    const callId = payload.call_id?.trim();
    if (!callId) {
      return;
    }

    const normalizedStatus = payload.status?.trim().toLowerCase();
    const isError = normalizedStatus === 'error' || normalizedStatus === 'failed' || normalizedStatus === 'cancelled';
    upsertMessage(state, {
      id: `tool:${callId}`,
      role: 'assistant',
      blocks: [createToolResultBlock(callId, stringifyUnknown(payload.output), isError)],
      status: isError ? 'error' : 'complete',
      createdAt: normalizeCreatedAt(timestamp, state.messageSequence++)
    });
  }
}

export function applyCodexJsonlLine(state: CodexJsonlMessagesState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }

  let parsed: CodexJsonlRecord;
  try {
    parsed = JSON.parse(trimmed) as CodexJsonlRecord;
  } catch {
    return false;
  }

  if (parsed.type === 'event_msg') {
    applyEventMsg(state, parsed.payload as CodexEventMsgPayload | undefined, parsed.timestamp);
    return true;
  }

  if (parsed.type === 'response_item') {
    applyResponseItem(state, parsed.payload as CodexResponseItemPayload | undefined, parsed.timestamp);
    return true;
  }

  return true;
}

export function materializeCodexJsonlMessages(state: CodexJsonlMessagesState): ChatMessage[] {
  return state.orderedIds
    .map((messageId) => state.messagesById.get(messageId))
    .filter((message): message is ChatMessage => Boolean(message));
}

export function parseCodexJsonlMessages(raw: string): {
  isRunning: boolean;
  messages: ChatMessage[];
} {
  const state = createCodexJsonlMessagesState();

  for (const line of raw.split('\n')) {
    applyCodexJsonlLine(state, line);
  }

  return {
    isRunning: state.runtimePhase === 'running',
    messages: materializeCodexJsonlMessages(state)
  };
}
