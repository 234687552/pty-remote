import { useEffect, useReducer } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { MessagesUpsertPayload } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ChatMessage, RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { createEmptySnapshot, mergeChronologicalMessages } from '@/lib/runtime.ts';
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

import type { WorkspacePane } from './types.ts';

interface WorkspaceState {
  error: string;
  hasOlderMessages: boolean;
  mobilePane: WorkspacePane;
  olderMessages: ChatMessage[];
  olderMessagesLoading: boolean;
  projectLoadingId: string | null;
  projectConversationsByKey: Record<string, ProjectConversationEntry[]>;
  projectsRefreshing: boolean;
  prompt: string;
  sidebarToggleTop: number;
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
      type: 'sidebar-toggle/previewed';
      value: SetStateAction<number>;
    }
  | {
      type: 'sidebar-toggle/committed';
      value: number;
    }
  | {
      type: 'error/set';
      value: SetStateAction<string>;
    }
  | {
      type: 'has-older-messages/set';
      value: SetStateAction<boolean>;
    }
  | {
      type: 'mobile-pane/set';
      value: SetStateAction<WorkspacePane>;
    }
  | {
      type: 'older-messages/set';
      value: SetStateAction<ChatMessage[]>;
    }
  | {
      type: 'older-messages-loading/set';
      value: SetStateAction<boolean>;
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
      type: 'runtime/messages-upserted';
      payload: MessagesUpsertPayload;
    }
  | {
      type: 'runtime/older-messages-merged';
      hasOlderMessages: boolean;
      messages: ChatMessage[];
    };

export interface WorkspaceStore {
  error: string;
  hasOlderMessages: boolean;
  mobilePane: WorkspacePane;
  olderMessages: ChatMessage[];
  olderMessagesLoading: boolean;
  projectLoadingId: string | null;
  projectConversationsByKey: Record<string, ProjectConversationEntry[]>;
  projectsRefreshing: boolean;
  prompt: string;
  sidebarToggleTop: number;
  snapshot: RuntimeSnapshot;
  workspaceState: PersistedWorkspaceState;
  applyMessagesUpsert: (payload: MessagesUpsertPayload) => void;
  commitSidebarToggleTop: (value: number) => void;
  dispatch: Dispatch<WorkspaceAction>;
  mergeOlderMessages: (messages: ChatMessage[], hasOlderMessages: boolean) => void;
  patchWorkspace: (updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState) => void;
  resetRuntimeForCliChange: () => void;
  resetRuntimeForDraftThread: () => void;
  setError: Dispatch<SetStateAction<string>>;
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>;
  setMobilePane: Dispatch<SetStateAction<WorkspacePane>>;
  setOlderMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setOlderMessagesLoading: Dispatch<SetStateAction<boolean>>;
  setProjectLoadingId: Dispatch<SetStateAction<string | null>>;
  setProjectConversations: (
    projectId: string,
    providerId: ProviderId,
    updater: (conversations: ProjectConversationEntry[]) => ProjectConversationEntry[]
  ) => void;
  setProjectsRefreshing: Dispatch<SetStateAction<boolean>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSidebarToggleTop: Dispatch<SetStateAction<number>>;
  setSnapshot: Dispatch<SetStateAction<RuntimeSnapshot>>;
}

function resolveStateUpdate<T>(current: T, value: SetStateAction<T>): T {
  return typeof value === 'function' ? (value as (current: T) => T)(current) : value;
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
        hasOlderMessages: false
      };

  if (isSameConversation && payload.sessionId && baseSnapshot.sessionId !== payload.sessionId) {
    baseSnapshot.sessionId = payload.sessionId;
  }

  const messagesById = new Map(baseSnapshot.messages.map((message) => [message.id, message]));
  for (const message of payload.upserts) {
    messagesById.set(message.id, message);
  }

  return {
    ...baseSnapshot,
    messages: payload.recentMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter(Boolean) as ChatMessage[],
    hasOlderMessages: payload.hasOlderMessages
  };
}

function createInitialWorkspaceState(): WorkspaceState {
  const workspaceState = loadWorkspaceState();
  const projectConversationsByKey = loadProjectConversationsState(workspaceState.projects);
  return {
    error: '',
    hasOlderMessages: false,
    mobilePane: 'chat',
    olderMessages: [],
    olderMessagesLoading: false,
    projectLoadingId: null,
    projectConversationsByKey,
    projectsRefreshing: false,
    prompt: '',
    sidebarToggleTop: workspaceState.sidebarToggleTop,
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
    case 'sidebar-toggle/previewed':
      return { ...state, sidebarToggleTop: resolveStateUpdate(state.sidebarToggleTop, action.value) };
    case 'sidebar-toggle/committed': {
      if (state.sidebarToggleTop === action.value && state.workspaceState.sidebarToggleTop === action.value) {
        return state;
      }

      return {
        ...state,
        sidebarToggleTop: action.value,
        workspaceState:
          state.workspaceState.sidebarToggleTop === action.value
            ? state.workspaceState
            : { ...state.workspaceState, sidebarToggleTop: action.value }
      };
    }
    case 'error/set':
      return { ...state, error: resolveStateUpdate(state.error, action.value) };
    case 'has-older-messages/set':
      return { ...state, hasOlderMessages: resolveStateUpdate(state.hasOlderMessages, action.value) };
    case 'mobile-pane/set':
      return { ...state, mobilePane: resolveStateUpdate(state.mobilePane, action.value) };
    case 'older-messages/set':
      return { ...state, olderMessages: resolveStateUpdate(state.olderMessages, action.value) };
    case 'older-messages-loading/set':
      return { ...state, olderMessagesLoading: resolveStateUpdate(state.olderMessagesLoading, action.value) };
    case 'project-loading-id/set':
      return { ...state, projectLoadingId: resolveStateUpdate(state.projectLoadingId, action.value) };
    case 'projects-refreshing/set':
      return { ...state, projectsRefreshing: resolveStateUpdate(state.projectsRefreshing, action.value) };
    case 'prompt/set':
      return { ...state, prompt: resolveStateUpdate(state.prompt, action.value) };
    case 'snapshot/set': {
      const nextSnapshot = resolveStateUpdate(state.snapshot, action.value);
      if (!hasRuntimeTargetChanged(state.snapshot, nextSnapshot)) {
        return { ...state, snapshot: nextSnapshot };
      }

      return {
        ...state,
        snapshot: nextSnapshot,
        olderMessages: [],
        hasOlderMessages: nextSnapshot.hasOlderMessages,
        olderMessagesLoading: false
      };
    }
    case 'runtime/reset-for-cli-change':
      return {
        ...state,
        snapshot: createEmptySnapshot(),
        olderMessages: [],
        hasOlderMessages: false,
        olderMessagesLoading: false
      };
    case 'runtime/reset-for-draft-thread':
      return {
        ...state,
        snapshot: createEmptySnapshot(),
        olderMessages: [],
        hasOlderMessages: false,
        olderMessagesLoading: false
      };
    case 'runtime/messages-upserted': {
      const nextSnapshot = applyMessagesUpsert(state.snapshot, action.payload);
      const runtimeTargetChanged = hasRuntimeTargetChanged(state.snapshot, nextSnapshot);
      return {
        ...state,
        snapshot: nextSnapshot,
        olderMessages: runtimeTargetChanged ? [] : state.olderMessages,
        olderMessagesLoading: runtimeTargetChanged ? false : state.olderMessagesLoading,
        hasOlderMessages:
          runtimeTargetChanged || state.olderMessages.length === 0 ? action.payload.hasOlderMessages : state.hasOlderMessages
      };
    }
    case 'runtime/older-messages-merged':
      return {
        ...state,
        olderMessages: mergeChronologicalMessages(action.messages, state.olderMessages),
        hasOlderMessages: action.hasOlderMessages
      };
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
    saveProjectConversationsState(state.projectConversationsByKey, state.workspaceState.projects);
  }, [state.projectConversationsByKey, state.workspaceState.projects]);

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

  function commitSidebarToggleTop(value: number): void {
    dispatch({ type: 'sidebar-toggle/committed', value });
  }

  const setError: Dispatch<SetStateAction<string>> = (value) => {
    dispatch({ type: 'error/set', value });
  };

  const setHasOlderMessages: Dispatch<SetStateAction<boolean>> = (value) => {
    dispatch({ type: 'has-older-messages/set', value });
  };

  const setMobilePane: Dispatch<SetStateAction<WorkspacePane>> = (value) => {
    dispatch({ type: 'mobile-pane/set', value });
  };

  const setOlderMessages: Dispatch<SetStateAction<ChatMessage[]>> = (value) => {
    dispatch({ type: 'older-messages/set', value });
  };

  const setOlderMessagesLoading: Dispatch<SetStateAction<boolean>> = (value) => {
    dispatch({ type: 'older-messages-loading/set', value });
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

  const setSidebarToggleTop: Dispatch<SetStateAction<number>> = (value) => {
    dispatch({ type: 'sidebar-toggle/previewed', value });
  };

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

  function mergeOlderMessages(messages: ChatMessage[], hasOlderMessages: boolean): void {
    dispatch({ type: 'runtime/older-messages-merged', messages, hasOlderMessages });
  }

  return {
    error: state.error,
    hasOlderMessages: state.hasOlderMessages,
    mobilePane: state.mobilePane,
    olderMessages: state.olderMessages,
    olderMessagesLoading: state.olderMessagesLoading,
    projectLoadingId: state.projectLoadingId,
    projectConversationsByKey: state.projectConversationsByKey,
    projectsRefreshing: state.projectsRefreshing,
    prompt: state.prompt,
    sidebarToggleTop: state.sidebarToggleTop,
    snapshot: state.snapshot,
    workspaceState: state.workspaceState,
    applyMessagesUpsert: applyRuntimeMessagesUpsert,
    commitSidebarToggleTop,
    dispatch,
    mergeOlderMessages,
    patchWorkspace,
    resetRuntimeForCliChange,
    resetRuntimeForDraftThread,
    setError,
    setHasOlderMessages,
    setMobilePane,
    setOlderMessages,
    setOlderMessagesLoading,
    setProjectLoadingId,
    setProjectConversations,
    setProjectsRefreshing,
    setPrompt,
    setSidebarToggleTop,
    setSnapshot
  };
}
