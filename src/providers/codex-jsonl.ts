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
}

interface CodexEventMsgPayload {
  type?: string;
  message?: string;
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
}

export function createCodexJsonlMessagesState(): CodexJsonlMessagesState {
  return {
    orderedIds: [],
    messagesById: new Map<string, ChatMessage>(),
    runtimePhase: 'idle',
    activityRevision: 0,
    messageSequence: 0
  };
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
    const messageId = `codex:user:${sequence}`;
    const textBlock = createTextBlock(messageId, payload?.message ?? '');
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
    const messageId = `codex:assistant:${sequence}`;
    const blocks = extractTextBlocks(payload.content, messageId);
    if (blocks.length === 0) {
      return;
    }

    upsertMessage(state, {
      id: messageId,
      role: 'assistant',
      blocks,
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
