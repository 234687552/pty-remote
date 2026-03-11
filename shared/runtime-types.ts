export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'error';
export type RuntimeStatus = 'idle' | 'starting' | 'running' | 'error';

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

export interface ChatMessage {
  id: string;
  role: Role;
  blocks: ChatMessageBlock[];
  status: MessageStatus;
  createdAt: string;
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  sessionId: string | null;
  messages: ChatMessage[];
  hasOlderMessages: boolean;
  lastError: string | null;
}

export interface CliDescriptor {
  cliId: string;
  label: string;
  cwd: string;
  runtimeBackend: string;
  connected: boolean;
  status: RuntimeStatus;
  sessionId: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
}
