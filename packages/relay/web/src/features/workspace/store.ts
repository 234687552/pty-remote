import { useEffect, useReducer } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { MessageDeltaPayload, MessagesUpsertPayload } from '@lzdi/pty-remote-protocol/protocol.ts';
import { DEFAULT_RUNTIME_MESSAGES_WINDOW_MAX, type ChatMessage, type RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { createEmptySnapshot, sortChronologicalMessages } from '@/lib/runtime.ts';
import {
  getProjectProviderKey,
  loadProjectConversationsState,
  loadWorkspaceState,
  saveProjectConversationsState,
  saveWorkspaceState,
  type PersistedWorkspaceState,
  type ProjectConversationEntry
} from '@/lib/workspace.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import type { ComposerAttachment, SentAttachmentBinding, WorkspacePane } from './types.ts';

interface WorkspaceState {
  error: string;
  mobilePane: WorkspacePane;
  pendingAttachments: ComposerAttachment[];
  projectLoadingId: string | null;
  projectConversationsByKey: Record<string, ProjectConversationEntry[]>;
  projectsRefreshing: boolean;
  prompt: string;
  sentAttachmentBindingsByConversationId: Record<string, SentAttachmentBinding[]>;
  snapshot: RuntimeSnapshot;
  workspaceState: PersistedWorkspaceState;
}

type WorkspaceAction =
  | {
      type: 'workspace/patched';
      updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState;
    }
  | {
      type: 'conversations/patched';
      projectId: string;
      providerId: ProviderId;
      updater: (conversations: ProjectConversationEntry[]) => ProjectConversationEntry[];
    }
  | {
      type: 'error/set';
      value: SetStateAction<string>;
    }
  | {
      type: 'mobile-pane/set';
      value: SetStateAction<WorkspacePane>;
    }
  | {
      type: 'pending-attachments/set';
      value: SetStateAction<ComposerAttachment[]>;
    }
  | {
      type: 'project-loading-id/set';
      value: SetStateAction<string | null>;
    }
  | {
      type: 'projects-refreshing/set';
      value: SetStateAction<boolean>;
    }
  | {
      type: 'prompt/set';
      value: SetStateAction<string>;
    }
  | {
      type: 'sent-attachment-bindings/patched';
      conversationId: string;
      updater: (bindings: SentAttachmentBinding[]) => SentAttachmentBinding[];
    }
  | {
      type: 'snapshot/set';
      value: SetStateAction<RuntimeSnapshot>;
    }
  | {
      type: 'runtime/reset-for-cli-change';
    }
  | {
      type: 'runtime/reset-for-draft-thread';
    }
  | {
      type: 'runtime/message-delta-received';
      payload: MessageDeltaPayload;
    }
  | {
      type: 'runtime/messages-upserted';
      payload: MessagesUpsertPayload;
    };

export interface WorkspaceStore {
  error: string;
  mobilePane: WorkspacePane;
  pendingAttachments: ComposerAttachment[];
  projectLoadingId: string | null;
  projectConversationsByKey: Record<string, ProjectConversationEntry[]>;
  projectsRefreshing: boolean;
  prompt: string;
  sentAttachmentBindingsByConversationId: Record<string, SentAttachmentBinding[]>;
  snapshot: RuntimeSnapshot;
  workspaceState: PersistedWorkspaceState;
  applyMessageDelta: (payload: MessageDeltaPayload) => void;
  applyMessagesUpsert: (payload: MessagesUpsertPayload) => void;
  dispatch: Dispatch<WorkspaceAction>;
  patchWorkspace: (updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState) => void;
  resetRuntimeForCliChange: () => void;
  resetRuntimeForDraftThread: () => void;
  setError: Dispatch<SetStateAction<string>>;
  setMobilePane: Dispatch<SetStateAction<WorkspacePane>>;
  setPendingAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
  setProjectLoadingId: Dispatch<SetStateAction<string | null>>;
  setProjectConversations: (
    projectId: string,
    providerId: ProviderId,
    updater: (conversations: ProjectConversationEntry[]) => ProjectConversationEntry[]
  ) => void;
  setProjectsRefreshing: Dispatch<SetStateAction<boolean>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSentAttachmentBindings: (
    conversationId: string,
    updater: (bindings: SentAttachmentBinding[]) => SentAttachmentBinding[]
  ) => void;
  setSnapshot: Dispatch<SetStateAction<RuntimeSnapshot>>;
}

function resolveStateUpdate<T>(current: T, value: SetStateAction<T>): T {
  return typeof value === 'function' ? (value as (current: T) => T)(current) : value;
}

function trimRuntimeMessages(messages: ChatMessage[]): { messages: ChatMessage[]; hasOlderMessages: boolean } {
  if (messages.length <= DEFAULT_RUNTIME_MESSAGES_WINDOW_MAX) {
    return {
      messages,
      hasOlderMessages: false
    };
  }
  return {
    messages: messages.slice(-DEFAULT_RUNTIME_MESSAGES_WINDOW_MAX),
    hasOlderMessages: true
  };
}

function applyMessagesUpsert(current: RuntimeSnapshot, payload: MessagesUpsertPayload): RuntimeSnapshot {
  const isSameConversation =
    current.providerId === payload.providerId && current.conversationKey === payload.conversationKey;
  const baseSnapshot = isSameConversation
    ? current
    : {
        ...current,
        providerId: payload.providerId,
        conversationKey: payload.conversationKey,
        sessionId: payload.sessionId,
        messages: [],
        hasOlderMessages: false,
        transientNotice: null
      };

  if (isSameConversation && payload.sessionId && baseSnapshot.sessionId !== payload.sessionId) {
    baseSnapshot.sessionId = payload.sessionId;
  }

  const messagesById = new Map(baseSnapshot.messages.map((message) => [message.id, message]));
  for (const message of payload.upserts) {
    messagesById.set(message.id, message);
  }

  const trimmed = trimRuntimeMessages(sortChronologicalMessages([...messagesById.values()]));

  return {
    ...baseSnapshot,
    messages: trimmed.messages,
    hasOlderMessages: payload.hasOlderMessages || trimmed.hasOlderMessages
  };
}

function applyMessageDelta(current: RuntimeSnapshot, payload: MessageDeltaPayload): RuntimeSnapshot {
  const isSameConversation =
    current.providerId === payload.providerId && current.conversationKey === payload.conversationKey;
  if (!isSameConversation) {
    return current;
  }

  const messages: ChatMessage[] = current.messages.map((message): ChatMessage => {
    if (message.id !== payload.messageId) {
      return message;
    }

    const blocks = message.blocks.slice();
    const blockIndex = blocks.findIndex((block) => block.id === payload.blockId);
    if (blockIndex >= 0) {
      const block = blocks[blockIndex];
      if (payload.blockType === 'text' && block.type === 'text') {
        blocks[blockIndex] = {
          ...block,
          text: `${block.text}${payload.delta}`
        };
      } else if (payload.blockType === 'tool_result' && block.type === 'tool_result') {
        blocks[blockIndex] = {
          ...block,
          content: `${block.content}${payload.delta}`
        };
      }
    } else if (payload.blockType === 'text') {
      blocks.push({
        id: payload.blockId,
        type: 'text',
        text: payload.delta
      });
    } else {
      blocks.push({
        id: payload.blockId,
        type: 'tool_result',
        toolCallId: payload.messageId,
        content: payload.delta,
        isError: false
      });
    }

    return {
      ...message,
      blocks,
      status: message.status === 'error' ? 'error' : 'streaming'
    };
  });

  const trimmed = trimRuntimeMessages(sortChronologicalMessages(messages));

  return {
    ...current,
    messages: trimmed.messages,
    hasOlderMessages: current.hasOlderMessages || trimmed.hasOlderMessages
  };
}

function createInitialWorkspaceState(): WorkspaceState {
  const workspaceState = loadWorkspaceState();
  const projectConversationsByKey = loadProjectConversationsState();
  return {
    error: '',
    mobilePane: 'chat',
    pendingAttachments: [],
    projectLoadingId: null,
    projectConversationsByKey,
    projectsRefreshing: false,
    prompt: '',
    sentAttachmentBindingsByConversationId: {},
    snapshot: createEmptySnapshot(),
    workspaceState
  };
}

function hasRuntimeTargetChanged(current: RuntimeSnapshot, next: RuntimeSnapshot): boolean {
  return (
    current.providerId !== next.providerId ||
    current.sessionId !== next.sessionId ||
    current.conversationKey !== next.conversationKey
  );
}

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'workspace/patched': {
      const nextWorkspaceState = action.updater(state.workspaceState);
      return nextWorkspaceState === state.workspaceState ? state : { ...state, workspaceState: nextWorkspaceState };
    }
    case 'conversations/patched': {
      const storageKey = getProjectProviderKey(action.projectId, action.providerId);
      const currentConversations = state.projectConversationsByKey[storageKey] ?? [];
      const nextConversations = action.updater(currentConversations);
      if (nextConversations === currentConversations) {
        return state;
      }

      return {
        ...state,
        projectConversationsByKey: {
          ...state.projectConversationsByKey,
          [storageKey]: nextConversations
        }
      };
    }
    case 'error/set':
      return { ...state, error: resolveStateUpdate(state.error, action.value) };
    case 'mobile-pane/set':
      return { ...state, mobilePane: resolveStateUpdate(state.mobilePane, action.value) };
    case 'pending-attachments/set':
      return { ...state, pendingAttachments: resolveStateUpdate(state.pendingAttachments, action.value) };
    case 'project-loading-id/set':
      return { ...state, projectLoadingId: resolveStateUpdate(state.projectLoadingId, action.value) };
    case 'projects-refreshing/set':
      return { ...state, projectsRefreshing: resolveStateUpdate(state.projectsRefreshing, action.value) };
    case 'prompt/set':
      return { ...state, prompt: resolveStateUpdate(state.prompt, action.value) };
    case 'sent-attachment-bindings/patched': {
      const currentBindings = state.sentAttachmentBindingsByConversationId[action.conversationId] ?? [];
      const nextBindings = action.updater(currentBindings);
      if (nextBindings === currentBindings) {
        return state;
      }

      return {
        ...state,
        sentAttachmentBindingsByConversationId: {
          ...state.sentAttachmentBindingsByConversationId,
          [action.conversationId]: nextBindings
        }
      };
    }
    case 'snapshot/set': {
      const nextSnapshot = resolveStateUpdate(state.snapshot, action.value);
      if (!hasRuntimeTargetChanged(state.snapshot, nextSnapshot)) {
        return { ...state, snapshot: nextSnapshot };
      }

      return {
        ...state,
        snapshot: nextSnapshot
      };
    }
    case 'runtime/reset-for-cli-change':
      return {
        ...state,
        snapshot: createEmptySnapshot()
      };
    case 'runtime/reset-for-draft-thread':
      return {
        ...state,
        snapshot: createEmptySnapshot()
      };
    case 'runtime/message-delta-received':
      return {
        ...state,
        snapshot: applyMessageDelta(state.snapshot, action.payload)
      };
    case 'runtime/messages-upserted': {
      const nextSnapshot = applyMessagesUpsert(state.snapshot, action.payload);
      return {
        ...state,
        snapshot: nextSnapshot
      };
    }
    default:
      return state;
  }
}

export function useWorkspaceStore(): WorkspaceStore {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createInitialWorkspaceState);

  useEffect(() => {
    saveWorkspaceState(state.workspaceState);
  }, [state.workspaceState]);

  useEffect(() => {
    saveProjectConversationsState(state.projectConversationsByKey);
  }, [state.projectConversationsByKey]);

  function patchWorkspace(updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState): void {
    dispatch({ type: 'workspace/patched', updater });
  }

  function setProjectConversations(
    projectId: string,
    providerId: ProviderId,
    updater: (conversations: ProjectConversationEntry[]) => ProjectConversationEntry[]
  ): void {
    dispatch({ type: 'conversations/patched', projectId, providerId, updater });
  }

  const setError: Dispatch<SetStateAction<string>> = (value) => {
    dispatch({ type: 'error/set', value });
  };

  const setMobilePane: Dispatch<SetStateAction<WorkspacePane>> = (value) => {
    dispatch({ type: 'mobile-pane/set', value });
  };

  const setPendingAttachments: Dispatch<SetStateAction<ComposerAttachment[]>> = (value) => {
    dispatch({ type: 'pending-attachments/set', value });
  };

  const setProjectLoadingId: Dispatch<SetStateAction<string | null>> = (value) => {
    dispatch({ type: 'project-loading-id/set', value });
  };

  const setProjectsRefreshing: Dispatch<SetStateAction<boolean>> = (value) => {
    dispatch({ type: 'projects-refreshing/set', value });
  };

  const setPrompt: Dispatch<SetStateAction<string>> = (value) => {
    dispatch({ type: 'prompt/set', value });
  };

  function setSentAttachmentBindings(
    conversationId: string,
    updater: (bindings: SentAttachmentBinding[]) => SentAttachmentBinding[]
  ): void {
    dispatch({ type: 'sent-attachment-bindings/patched', conversationId, updater });
  }

  const setSnapshot: Dispatch<SetStateAction<RuntimeSnapshot>> = (value) => {
    dispatch({ type: 'snapshot/set', value });
  };

  function resetRuntimeForCliChange(): void {
    dispatch({ type: 'runtime/reset-for-cli-change' });
  }

  function resetRuntimeForDraftThread(): void {
    dispatch({ type: 'runtime/reset-for-draft-thread' });
  }

  function applyRuntimeMessagesUpsert(payload: MessagesUpsertPayload): void {
    dispatch({ type: 'runtime/messages-upserted', payload });
  }

  function applyRuntimeMessageDelta(payload: MessageDeltaPayload): void {
    dispatch({ type: 'runtime/message-delta-received', payload });
  }

  return {
    error: state.error,
    mobilePane: state.mobilePane,
    pendingAttachments: state.pendingAttachments,
    projectLoadingId: state.projectLoadingId,
    projectConversationsByKey: state.projectConversationsByKey,
    projectsRefreshing: state.projectsRefreshing,
    prompt: state.prompt,
    sentAttachmentBindingsByConversationId: state.sentAttachmentBindingsByConversationId,
    snapshot: state.snapshot,
    workspaceState: state.workspaceState,
    applyMessageDelta: applyRuntimeMessageDelta,
    applyMessagesUpsert: applyRuntimeMessagesUpsert,
    dispatch,
    patchWorkspace,
    resetRuntimeForCliChange,
    resetRuntimeForDraftThread,
    setError,
    setMobilePane,
    setPendingAttachments,
    setProjectLoadingId,
    setProjectConversations,
    setProjectsRefreshing,
    setPrompt,
    setSentAttachmentBindings,
    setSnapshot
  };
}
