import type { ChatMessage, CliDescriptor, RuntimeSnapshot } from './runtime-types.ts';

export interface CliRegisterPayload {
  cliId?: string;
  label?: string;
  cwd: string;
  threadKey?: string | null;
  sessionId?: string | null;
  runtimeBackend: string;
}

export interface CliRegisterResult {
  ok: boolean;
  cliId: string;
  error?: string;
}

export interface ProjectSessionSummary {
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
  | 'get-raw-jsonl'
  | 'get-older-messages'
  | 'pick-project-directory'
  | 'list-project-sessions'
  | 'select-thread';

export interface CliCommandPayloadMap {
  'send-message': { content: string };
  'stop-message': Record<string, never>;
  'reset-session': Record<string, never>;
  'get-runtime-snapshot': Record<string, never>;
  'get-raw-jsonl': {
    maxChars?: number;
  };
  'get-older-messages': {
    beforeMessageId?: string;
    maxMessages?: number;
  };
  'pick-project-directory': Record<string, never>;
  'list-project-sessions': {
    cwd: string;
    maxSessions?: number;
  };
  'select-thread': {
    cwd: string;
    threadKey: string;
    sessionId: string | null;
  };
}

export interface GetRawJsonlResultPayload {
  rawJsonl: string;
  threadKey: string | null;
  sessionId: string | null;
  truncated: boolean;
}

export interface GetRuntimeSnapshotResultPayload {
  snapshot: RuntimeSnapshot;
}

export interface GetOlderMessagesResultPayload {
  messages: ChatMessage[];
  threadKey: string | null;
  sessionId: string | null;
  hasOlderMessages: boolean;
}

export interface PickProjectDirectoryResultPayload {
  cwd: string;
  label: string;
}

export interface ListProjectSessionsResultPayload {
  cwd: string;
  label: string;
  sessions: ProjectSessionSummary[];
}

export interface SelectThreadResultPayload {
  cwd: string;
  label: string;
  threadKey: string;
  sessionId: string | null;
}

export interface CliCommandResultPayloadMap {
  'send-message': null;
  'stop-message': null;
  'reset-session': null;
  'get-runtime-snapshot': GetRuntimeSnapshotResultPayload;
  'get-raw-jsonl': GetRawJsonlResultPayload;
  'get-older-messages': GetOlderMessagesResultPayload;
  'pick-project-directory': PickProjectDirectoryResultPayload;
  'list-project-sessions': ListProjectSessionsResultPayload;
  'select-thread': SelectThreadResultPayload;
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
  threadKey: string | null;
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
