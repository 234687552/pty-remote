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

export type CliCommandName = 'send-message' | 'reset-session';

export interface CliCommandPayloadMap {
  'send-message': { content: string };
  'reset-session': Record<string, never>;
}

export interface CliCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  requestId: string;
  name: TName;
  payload: CliCommandPayloadMap[TName];
}

export interface CliCommandResult {
  ok: boolean;
  error?: string;
}

export interface MessagesUpdatePayload {
  busy: boolean;
  sessionId: string | null;
  messages: ChatMessage[];
  lastError: string | null;
}

export interface RawJsonlUpdatePayload {
  sessionId: string | null;
  baseLength: number;
  chunk: string;
  reset: boolean;
}

export interface TerminalChunkPayload {
  data: string;
  sessionId: string | null;
}

export interface WebInitPayload {
  cli: CliDescriptor | null;
  snapshot: RuntimeSnapshot | null;
}

export interface CliStatusPayload {
  cli: CliDescriptor | null;
}

export interface WebCommandEnvelope<TName extends CliCommandName = CliCommandName> {
  name: TName;
  payload: CliCommandPayloadMap[TName];
}
