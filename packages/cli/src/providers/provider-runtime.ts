import type {
  ManagedPtyHandleSummary,
  MessageDeltaPayload,
  ProviderRuntimeRegistration,
  ProjectSessionSummary,
  RuntimeMetaPayload,
  RuntimeRequestPayload,
  RuntimeRequestResolvedPayload,
  SelectConversationResultPayload,
  TerminalVisibilityPayload,
  TerminalFramePatchPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId, RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

export interface ProviderRuntimeSelection {
  cwd: string;
  label: string;
  sessionId: string | null;
  conversationKey: string;
}

export interface ProviderRuntimeCallbacks {
  emitMessageDelta(payload: Omit<MessageDeltaPayload, 'cliId'>): void;
  emitMessagesUpsert(payload: {
    providerId: ProviderId | null;
    conversationKey: string | null;
    sessionId: string | null;
    upserts: RuntimeSnapshot['messages'];
    recentMessageIds: string[];
    hasOlderMessages: boolean;
  }): void;
  emitRuntimeMeta(payload: Omit<RuntimeMetaPayload, 'cliId'>): void;
  emitRuntimeRequest(payload: Omit<RuntimeRequestPayload, 'cliId'>): void;
  emitRuntimeRequestResolved(payload: Omit<RuntimeRequestResolvedPayload, 'cliId'>): void;
  emitTerminalFramePatch(payload: Omit<TerminalFramePatchPayload, 'cliId' | 'providerId'>): void;
  emitTerminalSessionEvicted(payload: {
    conversationKey: string | null;
    reason: string;
    sessionId: string;
  }): void;
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
  getRegistrationPayload(): ProviderRuntimeRegistration;
  hydrateConversation(selection: ProviderRuntimeSelection & { maxMessages?: number }): Promise<RuntimeSnapshot | null>;
  listSlashCommands(): Promise<string[]>;
  listProjectConversations(projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]>;
  listManagedPtyHandles(): Promise<ManagedPtyHandleSummary[]>;
  resolveRuntimeRequest(payload: {
    error?: string | null;
    requestId: string | number;
    result?: unknown;
  }): Promise<void>;
  resetActiveConversation(): Promise<void>;
  setTerminalVisibility(payload: Omit<TerminalVisibilityPayload, 'targetCliId' | 'targetProviderId'>): Promise<void>;
  sendTerminalInput(input: string): Promise<void>;
  shutdown(): Promise<void>;
  stopActiveRun(): Promise<void>;
  updateTerminalSize(cols: number, rows: number): void;
}
