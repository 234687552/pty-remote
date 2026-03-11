import type { ChatMessage, CliDescriptor, RuntimeSnapshot } from './runtime-types.ts';

export interface CliRegisterPayload {
  cliId?: string;
  label?: string;
  cwd: string;
  runtimeBackend: string;
}

export interface CliRegisterResult {
  cliId: string;
}

export type CliCommandName = 'send-message' | 'reset-session' | 'get-raw-jsonl' | 'get-older-messages';

export interface CliCommandPayloadMap {
  'send-message': { content: string };
  'reset-session': Record<string, never>;
  'get-raw-jsonl': {
    maxChars?: number;
  };
  'get-older-messages': {
    beforeMessageId?: string;
    maxMessages?: number;
  };
}

export interface GetRawJsonlResultPayload {
  rawJsonl: string;
  sessionId: string | null;
  truncated: boolean;
}

export interface GetOlderMessagesResultPayload {
  messages: ChatMessage[];
  sessionId: string | null;
  hasOlderMessages: boolean;
}

export interface CliCommandResultPayloadMap {
  'send-message': null;
  'reset-session': null;
  'get-raw-jsonl': GetRawJsonlResultPayload;
  'get-older-messages': GetOlderMessagesResultPayload;
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
  data: string;
  sessionId: string | null;
}

export interface RuntimeSnapshotPayload {
  snapshot: RuntimeSnapshot;
}

export interface WebInitPayload {
  cli: CliDescriptor | null;
  snapshot: RuntimeSnapshot | null;
  terminalReplay: string;
}

export interface CliStatusPayload {
  cli: CliDescriptor | null;
}

export interface WebCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  name: TName;
  payload: CliCommandPayloadMap[TName];
}
