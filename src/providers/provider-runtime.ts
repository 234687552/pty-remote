import type {
  GetOlderMessagesResultPayload,
  ProjectSessionSummary,
  SelectConversationResultPayload,
  TerminalChunkPayload
} from '../../shared/protocol.ts';
import type { ProviderId, RuntimeSnapshot } from '../../shared/runtime-types.ts';

export interface ProviderRuntimeSelection {
  cwd: string;
  label: string;
  sessionId: string | null;
  conversationKey: string;
}

export interface ProviderRuntimeCallbacks {
  emitMessagesUpsert(payload: {
    providerId: ProviderId | null;
    conversationKey: string | null;
    sessionId: string | null;
    upserts: RuntimeSnapshot['messages'];
    recentMessageIds: string[];
    hasOlderMessages: boolean;
  }): void;
  emitSnapshot(snapshot: RuntimeSnapshot): void;
  emitTerminalChunk(payload: Omit<TerminalChunkPayload, 'cliId'>): void;
}

export interface ProviderRuntimeRegistration {
  cwd: string;
  sessionId: string | null;
  conversationKey: string | null;
}

export interface ProviderRuntime {
  readonly providerId: ProviderId;
  activateConversation(selection: ProviderRuntimeSelection): Promise<SelectConversationResultPayload>;
  dispatchMessage(content: string): Promise<void>;
  getOlderMessages(beforeMessageId?: string, maxMessages?: number): Promise<GetOlderMessagesResultPayload>;
  getRegistrationPayload(): ProviderRuntimeRegistration;
  getSnapshot(): RuntimeSnapshot;
  listProjectConversations(projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]>;
  replayActiveState(): Promise<void>;
  resetActiveConversation(): Promise<void>;
  shutdown(): Promise<void>;
  stopActiveRun(): Promise<void>;
  updateTerminalSize(cols: number, rows: number): void;
}
