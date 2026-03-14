import { PROVIDER_LABELS, type CliDescriptor, type ChatMessage, type ProviderId } from '@shared/runtime-types.ts';

import {
  createEmptySnapshot,
  getRuntimeStatusLabel,
  isBusyStatus,
  isCliOfflineMessage,
  mergeChronologicalMessages
} from '@/lib/runtime.ts';
import {
  compactPreview,
  getProjectProviderKey,
  type PersistedWorkspaceState,
  type ProjectConversationEntry,
  type ProjectEntry
} from '@/lib/workspace.ts';

import type { WorkspaceStore } from './store.ts';
import type { StatusBadge } from './types.ts';

export interface WorkspaceDerivedState {
  activeCli: CliDescriptor | null;
  activeCliId: string | null;
  activeProject: ProjectEntry | null;
  activeProjectConversations: ProjectConversationEntry[];
  activeProviderId: ProviderId | null;
  activeConversation: ProjectConversationEntry | null;
  busy: boolean;
  canSend: boolean;
  canStop: boolean;
  connected: boolean;
  visibleMessages: ChatMessage[];
}

export interface ComposerViewModel {
  busy: boolean;
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
  return workspaceState.activeProviderId ?? activeCli?.providerId ?? null;
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
  return mergeChronologicalMessages(store.olderMessages, store.snapshot.messages);
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
  const visibleMessages = selectVisibleMessages(store);
  const connected = Boolean(socketConnected && activeCli?.connected);
  const busy = isBusyStatus(store.snapshot.status);

  return {
    activeCli,
    activeCliId,
    activeProject,
    activeProjectConversations,
    activeProviderId,
    activeConversation,
    busy,
    canSend: connected && !busy && Boolean(activeProject && activeConversation && activeProviderId),
    canStop: connected && busy && Boolean(activeProject && activeConversation && activeProviderId),
    connected,
    visibleMessages
  };
}

export function selectFooterErrorText(store: WorkspaceStore): string {
  if (store.error && !isCliOfflineMessage(store.error)) {
    return store.error;
  }
  if (store.snapshot.lastError && !isCliOfflineMessage(store.snapshot.lastError)) {
    return store.snapshot.lastError;
  }
  return '';
}

export function selectHeaderSummary(store: WorkspaceStore, clis: CliDescriptor[]): string[] {
  const { activeCli, activeProject, activeProviderId, activeConversation } = selectWorkspaceDerivedState(store, clis, true);

  return [
    `CLI ${compactPreview(activeCli?.label ?? 'unselected', 28)}`,
    `Provider ${compactPreview(activeProviderId ? PROVIDER_LABELS[activeProviderId] : 'unselected', 18)}`,
    `项目 ${compactPreview(activeProject?.label ?? activeCli?.label ?? 'Workspace', 28)}`,
    `目录 ${compactPreview(activeProject?.cwd ?? activeCli?.cwd ?? '-', 56)}`,
    `会话 ${compactPreview(activeConversation?.title ?? '-', 36)}`,
    `Session ${compactPreview(activeConversation?.sessionId ?? store.snapshot.sessionId ?? '-', 24)}`
  ];
}

export function selectMobileHeaderTitle(store: WorkspaceStore, clis: CliDescriptor[]): string {
  const { activeCli, activeProject, activeConversation } = selectWorkspaceDerivedState(store, clis, true);
  return compactPreview(activeConversation?.title ?? activeProject?.label ?? activeCli?.label ?? 'pty-remote', 36);
}

export function selectMobileProjectTitle(store: WorkspaceStore, clis: CliDescriptor[]): string {
  const { activeProject } = selectWorkspaceDerivedState(store, clis, true);
  return compactPreview(activeProject?.label ?? 'pty-remote', 28);
}

export function selectComposerViewModel(store: WorkspaceStore, clis: CliDescriptor[], socketConnected: boolean): ComposerViewModel {
  const { activeCli, activeCliId, activeProject, activeProviderId, activeConversation, busy, canSend, canStop, connected } =
    selectWorkspaceDerivedState(store, clis, socketConnected);
  const providerLabel = activeProviderId ? PROVIDER_LABELS[activeProviderId] : 'provider';

  const conversationBadge: StatusBadge =
    !activeProject || !activeConversation
      ? {
          label: 'conversation',
          value: 'unselected',
          className: 'bg-zinc-100 text-zinc-600'
        }
      : store.snapshot.status === 'error'
        ? {
            label: 'conversation',
            value: 'error',
            className: 'bg-red-100 text-red-700'
          }
        : busy
          ? {
              label: 'conversation',
              value: getRuntimeStatusLabel(store.snapshot.status),
              className: 'bg-zinc-900 text-white'
            }
          : {
              label: 'conversation',
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

  const placeholder = !activeProject
    ? '先从左侧添加并选择一个项目目录。'
    : !activeProviderId
      ? '先为当前项目选择一个 provider。'
      : !connected
        ? '等待 CLI 连接...'
        : store.snapshot.status === 'starting'
          ? `${providerLabel} 正在启动...`
          : store.snapshot.status === 'running'
            ? `${providerLabel} 正在运行...`
            : store.snapshot.status === 'error'
              ? '上次运行出错，可继续输入或切到别的 conversation。'
              : activeConversation?.draft
                ? `这是一个新的 ${providerLabel} conversation，第一条消息会创建新 session。`
                : '输入消息，继续这个 conversation。';

  return {
    busy,
    canSend,
    canStop,
    cliBadge,
    conversationBadge,
    footerErrorText: selectFooterErrorText(store),
    placeholder,
    socketBadge
  };
}

export function selectSnapshotOrEmpty(snapshot = createEmptySnapshot()) {
  return snapshot;
}
