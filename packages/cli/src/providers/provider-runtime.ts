import type {
  ManagedPtyHandleSummary,
  ProviderRuntimeRegistration,
  ProjectSessionSummary,
  RuntimeMetaPayload,
  SelectConversationResultPayload,
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
  emitMessagesUpsert(payload: {
    providerId: ProviderId | null;
    conversationKey: string | null;
    sessionId: string | null;
    upserts: RuntimeSnapshot['messages'];
    recentMessageIds: string[];
    hasOlderMessages: boolean;
  }): void;
  emitRuntimeMeta(payload: Omit<RuntimeMetaPayload, 'cliId'>): void;
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
  listSlashCommands(): Promise<string[]>;
  listProjectConversations(projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]>;
  listManagedPtyHandles(): Promise<ManagedPtyHandleSummary[]>;
  resetActiveConversation(): Promise<void>;
  sendTerminalInput(input: string): Promise<void>;
  shutdown(): Promise<void>;
  stopActiveRun(): Promise<void>;
  updateTerminalSize(cols: number, rows: number): void;
}
