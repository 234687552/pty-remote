export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'streaming' | 'error';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  createdAt: string;
}

export interface RuntimeSnapshot {
  busy: boolean;
  sessionId: string | null;
  terminalReplay: string;
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
