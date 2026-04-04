import type { ChatMessage, CliDescriptor, ProviderId, RuntimeSnapshot, RuntimeStatus, RuntimeTransientNotice } from './runtime-types.ts';
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
  supportsTerminal: boolean;
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
  | 'list-slash-commands'
  | 'list-directory'
  | 'list-git-status-files'
  | 'read-project-file'
  | 'git-diff-file'
  | 'upload-attachment'
  | 'delete-attachment'
  | 'stop-message'
  | 'reset-session'
  | 'pick-project-directory'
  | 'list-project-conversations'
  | 'list-managed-pty-handles'
  | 'select-conversation'
  | 'hydrate-conversation'
  | 'cleanup-project'
  | 'cleanup-conversation';

export interface CliCommandPayloadMap {
  'send-message': { content: string };
  'list-slash-commands': Record<string, never>;
  'list-directory': {
    cwd: string;
    path?: string;
  };
  'list-git-status-files': {
    cwd: string;
  };
  'read-project-file': {
    cwd: string;
    maxBytes?: number;
    path: string;
  };
  'git-diff-file': {
    cwd: string;
    path: string;
    staged?: boolean;
  };
  'upload-attachment': {
    contentBase64: string;
    conversationKey: string | null;
    cwd: string;
    filename: string;
    mimeType: string;
    sessionId: string | null;
    size: number;
  };
  'delete-attachment': {
    attachmentId: string;
  };
  'stop-message': Record<string, never>;
  'reset-session': Record<string, never>;
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
  'hydrate-conversation': {
    cwd: string;
    conversationKey: string;
    sessionId: string | null;
    maxMessages?: number;
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

export interface HydrateConversationResultPayload {
  providerId: ProviderId;
  snapshot: RuntimeSnapshot;
}

export interface UploadAttachmentResultPayload {
  attachmentId: string;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
}

export interface ListSlashCommandsResultPayload {
  providerId: ProviderId;
  commands: string[];
}

export interface DirectoryEntrySummary {
  absolutePath: string;
  modifiedAt?: number;
  name: string;
  path: string;
  size?: number;
  type: 'file' | 'directory' | 'other';
}

export interface ListDirectoryResultPayload {
  cwd: string;
  entries: DirectoryEntrySummary[];
  path: string;
}

export type GitStatusFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitStatusFileSummary {
  absolutePath: string;
  fileName: string;
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  oldPath?: string;
  path: string;
  staged: boolean;
  status: GitStatusFileState;
}

export interface ListGitStatusFilesResultPayload {
  branch: string | null;
  cwd: string;
  stagedFiles: GitStatusFileSummary[];
  totalStaged: number;
  totalUnstaged: number;
  unstagedFiles: GitStatusFileSummary[];
}

export interface ReadProjectFileResultPayload {
  absolutePath: string;
  contentBase64?: string;
  cwd: string;
  isBinary: boolean;
  path: string;
  size: number;
  truncated: boolean;
}

export interface GitDiffFileResultPayload {
  cwd: string;
  diff: string;
  path: string;
  staged: boolean;
}

export interface CliCommandResultPayloadMap {
  'send-message': null;
  'list-slash-commands': ListSlashCommandsResultPayload;
  'list-directory': ListDirectoryResultPayload;
  'list-git-status-files': ListGitStatusFilesResultPayload;
  'read-project-file': ReadProjectFileResultPayload;
  'git-diff-file': GitDiffFileResultPayload;
  'upload-attachment': UploadAttachmentResultPayload;
  'delete-attachment': null;
  'stop-message': null;
  'reset-session': null;
  'pick-project-directory': PickProjectDirectoryResultPayload;
  'list-project-conversations': ListProjectSessionsResultPayload;
  'list-managed-pty-handles': ListManagedPtyHandlesResultPayload;
  'select-conversation': SelectConversationResultPayload;
  'hydrate-conversation': HydrateConversationResultPayload;
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

export interface TerminalInputPayload {
  targetCliId: string | null;
  targetProviderId: ProviderId | null;
  input: string;
}

export interface TerminalVisibilityPayload {
  targetCliId: string | null;
  targetProviderId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  visible: boolean;
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

export interface RuntimeMetaPayload {
  cliId: string;
  providerId: ProviderId;
  conversationKey: string | null;
  cwd: string;
  lastError: string | null;
  sessionId: string | null;
  status: RuntimeStatus;
  transientNotice: RuntimeTransientNotice | null;
}

export interface RuntimeRequestPayload {
  cliId: string;
  providerId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  requestId: string | number;
  method: string;
  params: unknown;
}

export interface RuntimeRequestResolvedPayload {
  cliId: string;
  providerId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  requestId: string | number;
}

export interface RuntimeRequestResponsePayload {
  targetCliId: string | null;
  targetProviderId: ProviderId | null;
  requestId: string | number;
  result?: unknown;
  error?: string | null;
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

export interface MessageDeltaPayload {
  cliId: string;
  providerId: ProviderId | null;
  conversationKey: string | null;
  sessionId: string | null;
  messageId: string;
  blockId: string;
  blockType: 'text' | 'tool_result';
  delta: string;
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
