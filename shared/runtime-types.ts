export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'error';
export type ChatMessageType = 'markdown' | 'tool-invocation';

export interface ChatMessage {
  id: string;
  role: Role;
  type: ChatMessageType;
  content: string;
  status: MessageStatus;
  createdAt: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

export interface RuntimeSnapshot {
  busy: boolean;
  sessionId: string | null;
  terminalReplay: string;
  rawJsonl: string;
  messages: ChatMessage[];
  lastError: string | null;
}

export interface CliDescriptor {
  cliId: string;
  label: string;
  cwd: string;
  runtimeBackend: string;
  connected: boolean;
  busy: boolean;
  sessionId: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
}
