import type { ChatMessage, CliDescriptor, ProviderId, RuntimeSnapshot } from './runtime-types.ts';
import type { TerminalFramePatch, TerminalFrameSnapshot } from './terminal-frame.ts';

export interface CliRegisterPayload {
  cliId?: string;
  label?: string;
  cwd: string;
  supportedProviders: ProviderId[];
  runtimes: Partial<Record<ProviderId, ProviderRuntimeRegistration>>;
  runtimeBackend: string;
}

export interface ProviderRuntimeRegistration {
  cwd: string;
  sessionId: string | null;
  conversationKey: string | null;
}

export interface CliRegisterResult {
  ok: boolean;
  cliId: string;
  error?: string;
  errorCode?: 'conflict';
}

export interface ProjectSessionSummary {
  providerId: ProviderId;
  sessionId: string;
  cwd: string;
  title: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
}

export type ManagedPtyLifecycle = 'attached' | 'detached' | 'exited' | 'error';

export interface ManagedPtyHandleSummary {
  conversationKey: string;
  sessionId: string | null;
  cwd: string;
  label: string;
  lifecycle: ManagedPtyLifecycle;
  hasPty: boolean;
  lastActivityAt: number | null;
}

export type CliCommandName =
  | 'send-message'
  | 'stop-message'
  | 'reset-session'
  | 'get-runtime-snapshot'
  | 'get-older-messages'
  | 'pick-project-directory'
  | 'list-project-conversations'
  | 'list-managed-pty-handles'
  | 'select-conversation'
  | 'cleanup-project'
  | 'cleanup-conversation';

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
  'list-managed-pty-handles': Record<string, never>;
  'select-conversation': {
    cwd: string;
    conversationKey: string;
    sessionId: string | null;
    clientRequestId?: string | null;
  };
  'cleanup-project': {
    cwd: string;
  };
  'cleanup-conversation': {
    cwd: string;
    conversationKey: string;
    sessionId: string | null;
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

export interface ListManagedPtyHandlesResultPayload {
  providerId: ProviderId;
  handles: ManagedPtyHandleSummary[];
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
  'list-managed-pty-handles': ListManagedPtyHandlesResultPayload;
  'select-conversation': SelectConversationResultPayload;
  'cleanup-project': null;
  'cleanup-conversation': null;
}

export interface CliCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  requestId: string;
  targetProviderId?: ProviderId | null;
  name: TName;
  payload: CliCommandPayloadMap[TName];
}

export interface CliCommandResult<TName extends CliCommandName = CliCommandName> {
  ok: boolean;
  error?: string;
  payload?: CliCommandResultPayloadMap[TName];
}

export interface TerminalFramePatchPayload {
  cliId: string;
  providerId: ProviderId;
  conversationKey: string | null;
  patch: TerminalFramePatch;
}

export interface TerminalSessionEvictedPayload {
  cliId: string;
  providerId: ProviderId;
  conversationKey: string | null;
  reason: string;
  sessionId: string;
}

export interface RuntimeSubscriptionPayload {
  targetCliId: string | null;
  targetProviderId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  lastSeq?: number | null;
  terminalEnabled?: boolean | null;
}

export interface TerminalFrameSyncRequestPayload {
  targetCliId: string | null;
  targetProviderId: ProviderId | null;
  lastRevision: number | null;
  sessionId: string | null;
}

export interface TerminalResizePayload {
  targetCliId: string | null;
  targetProviderId: ProviderId | null;
  cols: number;
  rows: number;
}

export interface TerminalFrameSyncResultPayload {
  ok: boolean;
  error?: string;
  providerId: ProviderId | null;
  sessionId: string | null;
  mode?: 'patches' | 'snapshot';
  snapshot?: TerminalFrameSnapshot;
  patches?: TerminalFramePatch[];
}

export interface RuntimeSnapshotPayload {
  cliId: string;
  providerId: ProviderId;
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
  seq?: number;
}

export interface WebInitPayload {
  clis: CliDescriptor[];
}

export interface CliStatusPayload {
  clis: CliDescriptor[];
}

export interface WebCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  targetCliId: string | null;
  targetProviderId?: ProviderId | null;
  name: TName;
  payload: CliCommandPayloadMap[TName];
}
