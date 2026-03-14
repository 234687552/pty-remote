import type { ChatMessage, CliDescriptor, ProviderId, RuntimeSnapshot } from './runtime-types.ts';

export interface CliRegisterPayload {
  cliId?: string;
  providerId: ProviderId;
  label?: string;
  cwd: string;
  conversationKey?: string | null;
  sessionId?: string | null;
  runtimeBackend: string;
}

export interface CliRegisterResult {
  ok: boolean;
  cliId: string;
  error?: string;
}

export interface ProjectSessionSummary {
  providerId: ProviderId;
  sessionId: string;
  title: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
}

export type CliCommandName =
  | 'send-message'
  | 'stop-message'
  | 'reset-session'
  | 'get-runtime-snapshot'
  | 'get-older-messages'
  | 'pick-project-directory'
  | 'list-project-conversations'
  | 'select-conversation';

export interface CliCommandPayloadMap {
  'send-message': { content: string };
  'stop-message': Record<string, never>;
  'reset-session': Record<string, never>;
  'get-runtime-snapshot': Record<string, never>;
  'get-older-messages': {
    beforeMessageId?: string;
    maxMessages?: number;
  };
  'pick-project-directory': Record<string, never>;
  'list-project-conversations': {
    cwd: string;
    maxSessions?: number;
  };
  'select-conversation': {
    cwd: string;
    conversationKey: string;
    sessionId: string | null;
    clientRequestId?: string | null;
  };
}

export interface GetRuntimeSnapshotResultPayload {
  snapshot: RuntimeSnapshot;
}

export interface GetOlderMessagesResultPayload {
  messages: ChatMessage[];
  providerId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  hasOlderMessages: boolean;
}

export interface PickProjectDirectoryResultPayload {
  cwd: string;
  label: string;
}

export interface ListProjectSessionsResultPayload {
  providerId: ProviderId;
  cwd: string;
  label: string;
  sessions: ProjectSessionSummary[];
}

export interface SelectConversationResultPayload {
  providerId: ProviderId;
  cwd: string;
  label: string;
  conversationKey: string;
  sessionId: string | null;
  clientRequestId?: string | null;
}

export interface CliCommandResultPayloadMap {
  'send-message': null;
  'stop-message': null;
  'reset-session': null;
  'get-runtime-snapshot': GetRuntimeSnapshotResultPayload;
  'get-older-messages': GetOlderMessagesResultPayload;
  'pick-project-directory': PickProjectDirectoryResultPayload;
  'list-project-conversations': ListProjectSessionsResultPayload;
  'select-conversation': SelectConversationResultPayload;
}

export interface CliCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  requestId: string;
  name: TName;
  payload: CliCommandPayloadMap[TName];
}

export interface CliCommandResult<TName extends CliCommandName = CliCommandName> {
  ok: boolean;
  error?: string;
  payload?: CliCommandResultPayloadMap[TName];
}

export interface TerminalChunkPayload {
  cliId: string;
  data: string;
  offset: number;
  sessionId: string | null;
}

export interface TerminalResumeRequestPayload {
  targetCliId: string | null;
  lastOffset: number;
  sessionId: string | null;
}

export interface TerminalResizePayload {
  targetCliId: string | null;
  cols: number;
  rows: number;
}

export interface TerminalResumeResultPayload {
  data: string;
  mode: 'delta' | 'reset';
  offset: number;
  sessionId: string | null;
}

export interface RuntimeSnapshotPayload {
  cliId: string;
  snapshot: RuntimeSnapshot;
}

export interface MessagesUpsertPayload {
  cliId: string;
  providerId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  upserts: ChatMessage[];
  recentMessageIds: string[];
  hasOlderMessages: boolean;
}

export interface WebInitPayload {
  clis: CliDescriptor[];
}

export interface CliStatusPayload {
  clis: CliDescriptor[];
}

export interface WebCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  targetCliId: string | null;
  name: TName;
  payload: CliCommandPayloadMap[TName];
}
