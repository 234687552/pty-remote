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
