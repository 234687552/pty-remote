import type {
  GetOlderMessagesResultPayload,
  ManagedPtyHandleSummary,
  ProviderRuntimeRegistration,
  ProjectSessionSummary,
  SelectConversationResultPayload,
  TerminalChunkPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId, RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

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
  emitTerminalChunk(payload: Omit<TerminalChunkPayload, 'cliId' | 'providerId'>): void;
}

export interface ProviderRuntime {
  readonly providerId: ProviderId;
  activateConversation(selection: ProviderRuntimeSelection): Promise<SelectConversationResultPayload>;
  cleanupConversation(target: {
    cwd: string;
    conversationKey: string;
    sessionId: string | null;
  }): Promise<void>;
  cleanupProject(cwd: string): Promise<void>;
  dispatchMessage(content: string): Promise<void>;
  getOlderMessages(beforeMessageId?: string, maxMessages?: number): Promise<GetOlderMessagesResultPayload>;
  getRegistrationPayload(): ProviderRuntimeRegistration;
  getSnapshot(): RuntimeSnapshot;
  listProjectConversations(projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]>;
  listManagedPtyHandles(): Promise<ManagedPtyHandleSummary[]>;
  replayActiveState(): Promise<void>;
  resetActiveConversation(): Promise<void>;
  shutdown(): Promise<void>;
  stopActiveRun(): Promise<void>;
  updateTerminalSize(cols: number, rows: number): void;
}
