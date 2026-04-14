import { useEffect, useReducer } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { MessageDeltaPayload, MessagesUpsertPayload } from '@lzdi/pty-remote-protocol/protocol.ts';
import {
  DEFAULT_RUNTIME_MESSAGES_WINDOW_MAX,
  type ChatMessage,
  type ChatMessageBlock,
  type RuntimeSnapshot
} from '@lzdi/pty-remote-protocol/runtime-types.ts';

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
  runtimeMessagesSeq: number;
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

function blocksEqual(left: ChatMessageBlock, right: ChatMessageBlock): boolean {
  if (left.id !== right.id || left.type !== right.type) {
    return false;
  }

  if (left.type === 'text' && right.type === 'text') {
    return left.text === right.text;
  }

  if (left.type === 'tool_use' && right.type === 'tool_use') {
    return left.toolCallId === right.toolCallId && left.toolName === right.toolName && left.input === right.input;
  }

  if (left.type === 'tool_result' && right.type === 'tool_result') {
    return left.toolCallId === right.toolCallId && left.content === right.content && left.isError === right.isError;
  }

  return false;
}

function mergeMessageBlocks(existingBlocks: ChatMessageBlock[], nextBlocks: ChatMessageBlock[]): ChatMessageBlock[] {
  if (existingBlocks.length === 0) {
    return nextBlocks;
  }

  if (nextBlocks.length === 0) {
    return existingBlocks;
  }

  const mergedBlocks = existingBlocks.slice();
  const blockIndexById = new Map(mergedBlocks.map((block, index) => [block.id, index]));

  for (const block of nextBlocks) {
    const existingIndex = blockIndexById.get(block.id);
    if (existingIndex === undefined) {
      blockIndexById.set(block.id, mergedBlocks.length);
      mergedBlocks.push(block);
      continue;
    }

    if (!blocksEqual(mergedBlocks[existingIndex]!, block)) {
      mergedBlocks[existingIndex] = block;
    }
  }

  return mergedBlocks;
}

function deriveMessageStatus(message: ChatMessage): ChatMessage['status'] {
  if (message.status === 'error') {
    return 'error';
  }

  return message.blocks.some((block) => block.type === 'tool_result' && block.isError) ? 'error' : message.status;
}

function mergeMessageUpsert(existing: ChatMessage | undefined, next: ChatMessage): ChatMessage {
  const mergedBlocks = mergeMessageBlocks(existing?.blocks ?? [], next.blocks);
  const mergedMessage: ChatMessage = {
    ...next,
    attachments: next.attachments ?? existing?.attachments,
    blocks: mergedBlocks,
    createdAt: next.createdAt || existing?.createdAt || next.createdAt,
    meta: next.meta ?? existing?.meta,
    sequence: Number.isFinite(next.sequence) ? next.sequence : existing?.sequence
  };

  return {
    ...mergedMessage,
    status: deriveMessageStatus(mergedMessage)
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
    messagesById.set(message.id, mergeMessageUpsert(messagesById.get(message.id), message));
  }

  const authoritativeMessages = payload.recentMessageIds
    .map((messageId) => messagesById.get(messageId))
    .filter((message): message is ChatMessage => Boolean(message));
  const nextMessages = authoritativeMessages.length > 0 || payload.recentMessageIds.length > 0
    ? authoritativeMessages
    : sortChronologicalMessages([...messagesById.values()]);
  const trimmed = trimRuntimeMessages(nextMessages);

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
    runtimeMessagesSeq: 0,
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
        runtimeMessagesSeq: 0,
        snapshot: nextSnapshot
      };
    }
    case 'runtime/reset-for-cli-change':
      return {
        ...state,
        runtimeMessagesSeq: 0,
        snapshot: createEmptySnapshot()
      };
    case 'runtime/reset-for-draft-thread':
      return {
        ...state,
        runtimeMessagesSeq: 0,
        snapshot: createEmptySnapshot()
      };
    case 'runtime/message-delta-received':
      return {
        ...state,
        snapshot: applyMessageDelta(state.snapshot, action.payload)
      };
    case 'runtime/messages-upserted': {
      const payloadSeq = Number.isFinite(action.payload.seq) ? (action.payload.seq as number) : null;
      const isSameConversation =
        state.snapshot.providerId === action.payload.providerId &&
        state.snapshot.conversationKey === action.payload.conversationKey &&
        state.snapshot.sessionId === action.payload.sessionId;
      if (isSameConversation && payloadSeq !== null && payloadSeq <= state.runtimeMessagesSeq) {
        return state;
      }
      const nextSnapshot = applyMessagesUpsert(state.snapshot, action.payload);
      return {
        ...state,
        runtimeMessagesSeq: payloadSeq ?? state.runtimeMessagesSeq,
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
