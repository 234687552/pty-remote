export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'error';
export type RuntimeStatus = 'idle' | 'starting' | 'running' | 'error';
export type ProviderId = 'claude' | 'codex';

export interface RuntimeTransientNotice {
  kind: 'info' | 'warning' | 'error';
  message: string;
  details?: string | null;
  retrying?: boolean;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'claude',
  codex: 'codex'
};

export const BUILTIN_SLASH_COMMANDS: Record<ProviderId, string[]> = {
  claude: ['clear', 'compact', 'context', 'cost', 'doctor', 'help', 'plan', 'stats', 'status'],
  codex: ['review', 'new', 'compat', 'undo', 'diff', 'status', 'permissions']
};

export const DEFAULT_RUNTIME_MESSAGES_WINDOW_MAX = 80;

export interface TextChatMessageBlock {
  id: string;
  type: 'text';
  text: string;
}

export interface ToolUseChatMessageBlock {
  id: string;
  type: 'tool_use';
  toolCallId?: string;
  toolName: string;
  input: string;
}

export interface ToolResultChatMessageBlock {
  id: string;
  type: 'tool_result';
  toolCallId?: string;
  content: string;
  isError: boolean;
}

export type ChatMessageBlock = TextChatMessageBlock | ToolUseChatMessageBlock | ToolResultChatMessageBlock;

export interface ChatAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
  previewUrl?: string;
}

export interface ChatMessageMeta {
  phase?: string | null;
  turnId?: string | null;
}

export interface ChatMessage {
  id: string;
  role: Role;
  blocks: ChatMessageBlock[];
  attachments?: ChatAttachment[];
  meta?: ChatMessageMeta;
  status: MessageStatus;
  createdAt: string;
  sequence?: number;
}

function getChatMessageSequenceValue(message: Pick<ChatMessage, 'sequence'>): number | null {
  return Number.isFinite(message.sequence) ? (message.sequence as number) : null;
}

function getChatMessageTimestampValue(message: Pick<ChatMessage, 'createdAt'>): number | null {
  const parsed = new Date(message.createdAt).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getChatMessageTurnId(message: Pick<ChatMessage, 'meta'>): string | null {
  const turnId = message.meta?.turnId?.trim();
  return turnId ? turnId : null;
}

function compareChatMessageTurnCausality(left: ChatMessage, right: ChatMessage): number {
  const leftTurnId = getChatMessageTurnId(left);
  const rightTurnId = getChatMessageTurnId(right);
  if (!leftTurnId || leftTurnId !== rightTurnId || left.role === right.role) {
    return 0;
  }

  // A turn's user prompt is the cause of every assistant/tool item in that turn.
  return left.role === 'user' ? -1 : 1;
}

export function compareChatMessageChronology(left: ChatMessage, right: ChatMessage): number {
  const turnCausalityOrder = compareChatMessageTurnCausality(left, right);
  if (turnCausalityOrder !== 0) {
    return turnCausalityOrder;
  }

  const leftSequence = getChatMessageSequenceValue(left);
  const rightSequence = getChatMessageSequenceValue(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  const leftTimestamp = getChatMessageTimestampValue(left);
  const rightTimestamp = getChatMessageTimestampValue(right);
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  if (leftSequence !== null && rightSequence === null) {
    return -1;
  }
  if (leftSequence === null && rightSequence !== null) {
    return 1;
  }

  if (leftTimestamp !== null && rightTimestamp === null) {
    return -1;
  }
  if (leftTimestamp === null && rightTimestamp !== null) {
    return 1;
  }

  return left.id.localeCompare(right.id);
}

export function sortChatMessagesChronologically(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice().sort(compareChatMessageChronology);
}

export interface RuntimeSnapshot {
  providerId: ProviderId | null;
  conversationKey: string | null;
  status: RuntimeStatus;
  sessionId: string | null;
  messages: ChatMessage[];
  hasOlderMessages: boolean;
  lastError: string | null;
  transientNotice: RuntimeTransientNotice | null;
}

export interface CliProviderRuntimeDescriptor {
  cwd: string;
  conversationKey: string | null;
  status: RuntimeStatus;
  sessionId: string | null;
  supportsTerminal: boolean;
}

export interface CliDescriptor {
  cliId: string;
  label: string;
  cwd: string;
  supportedProviders: ProviderId[];
  runtimes: Partial<Record<ProviderId, CliProviderRuntimeDescriptor>>;
  runtimeBackend: string;
  connected: boolean;
  connectedAt: string | null;
  lastSeenAt: string | null;
}
