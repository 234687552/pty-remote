import type { ChatMessage, ChatMessageBlock, CliDescriptor, ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import {
  getRuntimeStatusLabel,
  isBusyStatus,
  isCliOfflineMessage,
  mergeChronologicalMessages,
} from '@/lib/runtime.ts';
import {
  compactPreview,
  getProjectProviderKey,
  type PersistedWorkspaceState,
  type ProjectConversationEntry,
  type ProjectEntry
} from '@/lib/workspace.ts';

import type { WorkspaceStore } from './store.ts';
import type { SentAttachmentBinding, StatusBadge } from './types.ts';

export interface WorkspaceDerivedState {
  activeCli: CliDescriptor | null;
  activeCliId: string | null;
  activeProject: ProjectEntry | null;
  activeProjectConversations: ProjectConversationEntry[];
  activeProviderId: ProviderId | null;
  activeConversation: ProjectConversationEntry | null;
  busy: boolean;
  canAttach: boolean;
  canCompose: boolean;
  canSend: boolean;
  canStop: boolean;
  connected: boolean;
  terminalSupported: boolean;
  visibleMessages: ChatMessage[];
}

export interface ComposerViewModel {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  busy: boolean;
  canAttach: boolean;
  canCompose: boolean;
  canSend: boolean;
  canStop: boolean;
  cliBadge: StatusBadge;
  conversationBadge: StatusBadge;
  footerErrorText: string;
  placeholder: string;
  socketBadge: StatusBadge;
}

export function selectActiveProject(workspaceState: PersistedWorkspaceState): ProjectEntry | null {
  return workspaceState.projects.find((project) => project.id === workspaceState.activeProjectId) ?? null;
}

export function selectActiveProviderId(workspaceState: PersistedWorkspaceState, activeCli: CliDescriptor | null = null): ProviderId | null {
  return workspaceState.activeProviderId ?? activeCli?.supportedProviders[0] ?? null;
}

export function selectActiveCliId(workspaceState: PersistedWorkspaceState): string | null {
  return workspaceState.activeCliId;
}

export function selectActiveCli(clis: CliDescriptor[], activeCliId: string | null): CliDescriptor | null {
  return clis.find((cli) => cli.cliId === activeCliId) ?? null;
}

export function selectProjectConversations(
  projectConversationsByKey: Record<string, ProjectConversationEntry[]>,
  activeProject: ProjectEntry | null,
  activeProviderId: ProviderId | null
): ProjectConversationEntry[] {
  if (!activeProject || !activeProviderId) {
    return [];
  }

  return projectConversationsByKey[getProjectProviderKey(activeProject.id, activeProviderId)] ?? [];
}

export function selectActiveConversation(
  workspaceState: PersistedWorkspaceState,
  activeProjectConversations: ProjectConversationEntry[]
): ProjectConversationEntry | null {
  return (
    activeProjectConversations.find((conversation) => conversation.id === workspaceState.activeConversationId) ??
    activeProjectConversations[0] ??
    null
  );
}

export function selectVisibleMessages(store: WorkspaceStore): ChatMessage[] {
  return store.snapshot.messages;
}

function getUserMessageText(message: ChatMessage): string {
  return message.blocks
    .filter((block): block is Extract<ChatMessageBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function createDisplayTextBlocks(messageId: string, displayText: string): ChatMessageBlock[] {
  const trimmed = displayText.trim();
  if (!trimmed) {
    return [];
  }

  return [
    {
      id: `${messageId}:attachment-text:0`,
      type: 'text',
      text: trimmed
    }
  ];
}

function bindAttachmentsToMessages(messages: ChatMessage[], bindings: SentAttachmentBinding[]): ChatMessage[] {
  if (bindings.length === 0) {
    return messages;
  }

  const userMessageIndexes = messages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => message.role === 'user');
  const matchedMessageIndexes = new Map<number, SentAttachmentBinding>();
  let searchIndex = userMessageIndexes.length - 1;

  for (let bindingIndex = bindings.length - 1; bindingIndex >= 0; bindingIndex -= 1) {
    const binding = bindings[bindingIndex];
    for (let userIndex = searchIndex; userIndex >= 0; userIndex -= 1) {
      const candidate = userMessageIndexes[userIndex];
      if (!candidate) {
        continue;
      }

      if (getUserMessageText(candidate.message) !== binding.composedContent) {
        continue;
      }

      matchedMessageIndexes.set(candidate.index, binding);
      searchIndex = userIndex - 1;
      break;
    }
  }

  const matchedBindingIds = new Set([...matchedMessageIndexes.values()].map((binding) => binding.id));
  const displayMessages = messages.map((message, index) => {
    const binding = matchedMessageIndexes.get(index);
    if (!binding) {
      return message;
    }

    return {
      ...message,
      blocks: createDisplayTextBlocks(message.id, binding.displayText),
      attachments: binding.attachments
    };
  });
  const optimisticMessages = bindings
    .filter((binding) => !matchedBindingIds.has(binding.id))
    .map((binding) => ({
      id: `local:attachment-binding:${binding.id}`,
      role: 'user' as const,
      blocks: createDisplayTextBlocks(`local:attachment-binding:${binding.id}`, binding.displayText),
      attachments: binding.attachments,
      status: 'complete' as const,
      createdAt: binding.createdAt
    }));

  return mergeChronologicalMessages(displayMessages, optimisticMessages);
}

export function selectWorkspaceDerivedState(
  store: WorkspaceStore,
  clis: CliDescriptor[],
  socketConnected: boolean
): WorkspaceDerivedState {
  const activeProject = selectActiveProject(store.workspaceState);
  const activeCliId = selectActiveCliId(store.workspaceState);
  const activeCli = selectActiveCli(clis, activeCliId);
  const activeProviderId = selectActiveProviderId(store.workspaceState, activeCli);
  const activeProjectConversations = selectProjectConversations(
    store.projectConversationsByKey,
    activeProject,
    activeProviderId
  );
  const activeConversation = selectActiveConversation(store.workspaceState, activeProjectConversations);
  const terminalSupported = activeProviderId ? activeCli?.runtimes[activeProviderId]?.supportsTerminal !== false : false;
  const conversationMatchesRuntime =
    Boolean(activeConversation) &&
    store.snapshot.providerId === activeProviderId &&
    store.snapshot.conversationKey === activeConversation!.conversationKey;
  const pendingAttachments = activeConversation
    ? store.pendingAttachments.filter((attachment) => attachment.conversationId === activeConversation.id)
    : [];
  const readyAttachmentCount = pendingAttachments.filter((attachment) => attachment.status === 'ready').length;
  const attachmentsReady = pendingAttachments.every((attachment) => attachment.status === 'ready');
  const sentAttachmentBindings = activeConversation
    ? store.sentAttachmentBindingsByConversationId[activeConversation.id] ?? []
    : [];
  const visibleMessages =
    activeProject && activeConversation && conversationMatchesRuntime
      ? bindAttachmentsToMessages(selectVisibleMessages(store), sentAttachmentBindings)
      : [];
  const connected = Boolean(socketConnected && activeCli?.connected);
  const busy = isBusyStatus(store.snapshot.status);
  const canCompose = connected && !busy && Boolean(activeProject && activeConversation && activeProviderId);
  const canAttach = connected && Boolean(activeProject && activeConversation && activeProviderId);
  const hasDraftContent = Boolean(store.prompt.trim()) || readyAttachmentCount > 0;
  const canSend = canCompose && attachmentsReady && hasDraftContent;

  return {
    activeCli,
    activeCliId,
    activeProject,
    activeProjectConversations,
    activeProviderId,
    activeConversation,
    busy,
    canAttach,
    canCompose,
    canSend,
    canStop: connected && busy && Boolean(activeProject && activeConversation && activeProviderId),
    connected,
    terminalSupported,
    visibleMessages
  };
}

export function selectFooterErrorText(store: Pick<WorkspaceStore, 'error' | 'snapshot'>): string {
  const candidates = [store.error, store.snapshot.lastError];
  const next = candidates.find(
    (message) => message && !isCliOfflineMessage(message) && !isCliCommandTimeoutMessage(message)
  );
  return next ?? '';
}

export function selectHeaderSummary(
  derivedState: Pick<WorkspaceDerivedState, 'activeCli' | 'activeProject' | 'activeConversation'>
): string[] {
  const { activeCli, activeProject, activeConversation } = derivedState;
  return [
    `CLI ${compactPreview(activeCli?.label ?? 'unselected', 28)}`,
    `目录 ${compactPreview(activeProject?.cwd ?? activeCli?.cwd ?? '-', 56)}`,
    `Session ${activeConversation?.sessionId ?? '-'}`
  ];
}

export function selectMobileProjectTitle(derivedState: Pick<WorkspaceDerivedState, 'activeProject'>): string {
  const { activeProject } = derivedState;
  return compactPreview(activeProject?.label ?? 'pty-remote', 28);
}

export function selectComposerViewModel(
  store: Pick<WorkspaceStore, 'error' | 'snapshot'>,
  derivedState: WorkspaceDerivedState,
  socketConnected: boolean
): ComposerViewModel {
  const {
    activeCli,
    activeCliId,
    activeProject,
    activeProviderId,
    activeConversation,
    busy,
    canAttach,
    canCompose,
    canSend,
    canStop
  } = derivedState;
  const hasCliCommandTimeout =
    isCliCommandTimeoutMessage(store.error) || isCliCommandTimeoutMessage(store.snapshot.lastError);

  const conversationBadge: StatusBadge =
    hasCliCommandTimeout
      ? {
          label: 'status',
          value: 'timeout',
          className: 'bg-amber-100 text-amber-700'
        }
      : !activeProject || !activeConversation
      ? {
          label: 'status',
          value: 'unselected',
          className: 'bg-zinc-100 text-zinc-600'
        }
      : store.snapshot.status === 'error'
        ? {
            label: 'status',
            value: 'error',
            className: 'bg-red-100 text-red-700'
          }
        : busy
          ? {
              label: 'status',
              value: getRuntimeStatusLabel(store.snapshot.status),
              className: 'bg-zinc-900 text-white'
            }
          : {
              label: 'status',
              value: getRuntimeStatusLabel(store.snapshot.status),
              className: 'bg-white/85 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]'
            };

  const socketBadge: StatusBadge = {
    label: 'socket',
    value: socketConnected ? 'online' : 'offline',
    className: socketConnected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
  };

  const cliBadge: StatusBadge =
    !activeCliId
      ? {
          label: 'cli',
          value: 'unselected',
          className: 'bg-zinc-100 text-zinc-600'
        }
      : {
          label: 'cli',
          value: activeCli?.connected ? 'online' : 'offline',
          className: activeCli?.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
        };

  const placeholder = '';

  return {
    activeCliId,
    activeProviderId,
    busy,
    canAttach,
    canCompose,
    canSend,
    canStop,
    cliBadge,
    conversationBadge,
    footerErrorText: selectFooterErrorText(store),
    placeholder,
    socketBadge
  };
}

function isCliCommandTimeoutMessage(message: string | null | undefined): boolean {
  return (message ?? '').trim().toLowerCase() === 'cli command timeout';
}
