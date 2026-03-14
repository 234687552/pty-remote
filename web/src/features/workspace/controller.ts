import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';

import type {
  GetOlderMessagesResultPayload,
  GetRuntimeSnapshotResultPayload,
  ListProjectSessionsResultPayload,
  PickProjectDirectoryResultPayload
} from '@shared/protocol.ts';
import { PROVIDER_LABELS, type CliDescriptor, type ProviderId } from '@shared/runtime-types.ts';

import type { CliSocketController } from '@/hooks/useCliSocket.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';
import { createEmptySnapshot } from '@/lib/runtime.ts';
import {
  clampSidebarToggleTop,
  createDraftConversation,
  getProjectProviderKey,
  hydrateConversationFromSnapshot,
  mergeProjectConversations,
  sortProjects,
  type ProjectConversationEntry,
  type ProjectEntry
} from '@/lib/workspace.ts';

import { selectWorkspaceDerivedState } from './selectors.ts';
import type { WorkspaceStore } from './store.ts';

export interface WorkspaceController {
  activateConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => Promise<void>;
  addProject: () => Promise<void>;
  loadOlderMessages: (beforeMessageId: string | undefined) => Promise<boolean>;
  refreshAllProjectConversations: () => Promise<void>;
  selectCli: (cliId: string | null) => void;
  selectProject: (project: ProjectEntry) => void;
  selectProvider: (project: ProjectEntry, providerId: ProviderId) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  stopMessage: () => Promise<void>;
  submitPrompt: (event: React.FormEvent) => Promise<void>;
}

interface UseWorkspaceControllerParams {
  clis: CliDescriptor[];
  sendCommand: CliSocketController['sendCommand'];
  socketConnected: boolean;
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

function getConnectedCliForProvider(
  clis: CliDescriptor[],
  providerId: ProviderId | null,
  preferredCliId: string | null
): CliDescriptor | null {
  if (!providerId) {
    return null;
  }

  const candidates = clis.filter((cli) => cli.connected && cli.providerId === providerId);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.find((cli) => cli.cliId === preferredCliId) ?? candidates[0] ?? null;
}

function getProviderIds(clis: CliDescriptor[]): ProviderId[] {
  return [...new Set(clis.filter((cli) => cli.connected).map((cli) => cli.providerId))];
}

export function useWorkspaceController({
  clis,
  sendCommand,
  socketConnected,
  store,
  terminal
}: UseWorkspaceControllerParams): WorkspaceController {
  const projectRefreshInFlightRef = useRef(new Map<string, Promise<ListProjectSessionsResultPayload>>());
  const requestedConversationKeyRef = useRef<string | null>(null);
  const sendCommandRef = useRef(sendCommand);
  const sidebarRefreshTriggeredRef = useRef(false);
  const terminalRef = useRef(terminal);
  const previousSidebarCollapsedRef = useRef(store.workspaceState.sidebarCollapsed);
  const sidebarToggleTopRef = useRef(store.sidebarToggleTop);

  const {
    activeCli,
    activeCliId,
    activeProject,
    activeProjectConversations,
    activeProviderId,
    activeConversation,
    visibleMessages
  } = useMemo(
    () => selectWorkspaceDerivedState(store, clis, socketConnected),
    [
      clis,
      socketConnected,
      store.olderMessages,
      store.projectConversationsByKey,
      store.snapshot,
      store.workspaceState
    ]
  );
  const activeCliConnected = Boolean(activeCli?.connected);
  const connectedProviderIds = useMemo(() => getProviderIds(clis), [clis]);
  const connectedProviderIdsKey = connectedProviderIds.join('|');

  sidebarToggleTopRef.current = store.sidebarToggleTop;

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  useEffect(() => {
    terminalRef.current = terminal;
  }, [terminal]);

  useEffect(() => {
    if (!socketConnected) {
      return;
    }

    void terminal.resumeSession(store.snapshot.sessionId);
  }, [socketConnected, store.snapshot.sessionId]);

  useEffect(() => {
    if (store.mobilePane === 'terminal') {
      terminal.scheduleResize();
    }
  }, [store.mobilePane, terminal]);

  useEffect(() => {
    terminal.scheduleResize();
  }, [store.workspaceState.sidebarCollapsed, terminal]);

  useEffect(() => {
    const handleResize = () => {
      const nextTop = clampSidebarToggleTop(sidebarToggleTopRef.current, window.innerHeight);
      store.setSidebarToggleTop(nextTop);
      store.patchWorkspace((current) => {
        const clampedTop = clampSidebarToggleTop(current.sidebarToggleTop, window.innerHeight);
        return current.sidebarToggleTop === clampedTop ? current : { ...current, sidebarToggleTop: clampedTop };
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (clis.length === 0) {
      return;
    }

    const selectedCli = clis.find((cli) => cli.cliId === store.workspaceState.activeCliId && cli.connected) ?? null;
    const fallbackCli = selectedCli ?? clis.find((cli) => cli.connected) ?? null;
    if (!fallbackCli) {
      return;
    }

    store.patchWorkspace((current) => {
      const nextCliId = fallbackCli.cliId;
      const nextProviderId = current.activeProviderId ?? fallbackCli.providerId;
      if (current.activeCliId === nextCliId && current.activeProviderId === nextProviderId) {
        return current;
      }

      return {
        ...current,
        activeCliId: nextCliId,
        activeProviderId: nextProviderId
      };
    });
  }, [clis, store.workspaceState.activeCliId, store.workspaceState.activeProviderId]);

  useEffect(() => {
    const nextCli = getConnectedCliForProvider(clis, store.workspaceState.activeProviderId, store.workspaceState.activeCliId);
    if (!nextCli || nextCli.cliId === store.workspaceState.activeCliId) {
      return;
    }

    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextCli.cliId
    }));
  }, [clis, store.workspaceState.activeCliId, store.workspaceState.activeProviderId]);

  useEffect(() => {
    if (!activeProject || !activeProviderId || activeProjectConversations.length === 0 || activeConversation) {
      return;
    }

    store.patchWorkspace((current) =>
      current.activeProjectId === activeProject.id && current.activeProviderId === activeProviderId
        ? {
            ...current,
            activeConversationId: activeProjectConversations[0]?.id ?? null
          }
        : current
    );
  }, [activeConversation, activeProject, activeProjectConversations, activeProviderId]);

  useEffect(() => {
    if (!activeProject || !activeConversation || !activeCli || !activeProviderId) {
      return;
    }

    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const canHydrateFromSnapshot =
      backendMatchesProject &&
      store.snapshot.providerId === activeProviderId &&
      store.snapshot.conversationKey === activeConversation.conversationKey;
    if (!canHydrateFromSnapshot) {
      return;
    }

    store.setProjectConversations(activeProject.id, activeProviderId, (conversations) => {
      let changed = false;
      const nextConversations = conversations.map((conversation) => {
        if (conversation.id !== activeConversation.id) {
          return conversation;
        }

        const nextConversation = hydrateConversationFromSnapshot(conversation, store.snapshot, visibleMessages);
        const shouldUpdate =
          conversation.sessionId !== nextConversation.sessionId ||
          conversation.title !== nextConversation.title ||
          conversation.preview !== nextConversation.preview ||
          conversation.updatedAt !== nextConversation.updatedAt ||
          conversation.messageCount !== nextConversation.messageCount ||
          conversation.draft !== nextConversation.draft;

        if (!shouldUpdate) {
          return conversation;
        }

        changed = true;
        return nextConversation;
      });

      return changed ? nextConversations : conversations;
    });
  }, [
    activeCli,
    activeConversation,
    activeProject,
    activeProviderId,
    store,
    store.snapshot.conversationKey,
    store.snapshot.providerId,
    store.snapshot.sessionId,
    visibleMessages
  ]);

  useEffect(() => {
    if (!socketConnected || !activeCliId || !activeCliConnected) {
      store.resetRuntimeForCliChange();
      terminalRef.current.clearTerminal();
      return;
    }

    terminalRef.current.prepareForResume();
    store.resetRuntimeForCliChange();

    void sendCommandRef.current('get-runtime-snapshot', {}, activeCliId)
      .then(async (result) => {
        const nextSnapshot = (result.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
        store.setSnapshot(nextSnapshot);
        await terminalRef.current.resumeSession(nextSnapshot.sessionId, { force: true });
      })
      .catch((runtimeError) => {
        terminalRef.current.clearTerminal();
        store.setError(runtimeError instanceof Error ? runtimeError.message : '加载 CLI 运行态失败');
      });
  }, [activeCliConnected, activeCliId, socketConnected]);

  useEffect(() => {
    if (!socketConnected || store.workspaceState.sidebarCollapsed || store.projectsRefreshing) {
      return;
    }

    const nextTarget = store.workspaceState.projects
      .flatMap((project) =>
        connectedProviderIds.map((providerId) => ({
          project,
          providerId,
          storageKey: getProjectProviderKey(project.id, providerId)
        }))
      )
      .find(
        (target) =>
          !store.projectConversationsByKey[target.storageKey] && store.projectLoadingId !== target.storageKey
      );
    if (!nextTarget) {
      return;
    }

    void refreshProjectConversations(nextTarget.project, nextTarget.providerId).catch((refreshError) => {
      store.setError(
        refreshError instanceof Error ? refreshError.message : `刷新项目 ${nextTarget.project.label} 失败`
      );
    });
  }, [
    connectedProviderIdsKey,
    socketConnected,
    store.projectConversationsByKey,
    store.projectLoadingId,
    store.projectsRefreshing,
    store.workspaceState.projects,
    store.workspaceState.sidebarCollapsed
  ]);

  useEffect(() => {
    const wasCollapsed = previousSidebarCollapsedRef.current;
    previousSidebarCollapsedRef.current = store.workspaceState.sidebarCollapsed;

    if (store.workspaceState.sidebarCollapsed || store.workspaceState.projects.length === 0 || store.projectLoadingId || store.projectsRefreshing) {
      return;
    }

    if (!wasCollapsed && sidebarRefreshTriggeredRef.current) {
      return;
    }

    sidebarRefreshTriggeredRef.current = true;
    void refreshAllProjectConversations();
  }, [
    store.projectLoadingId,
    store.projectsRefreshing,
    store.workspaceState.projects.length,
    store.workspaceState.sidebarCollapsed
  ]);

  useEffect(() => {
    if (!socketConnected || !activeCli?.connected || !activeProject || !activeConversation || !activeProviderId) {
      return;
    }

    const conversationKey = activeConversation.conversationKey;
    const requestKey = `${activeCli.cliId}:${activeProviderId}:${conversationKey}:${activeConversation.sessionId ?? 'draft'}`;
    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const backendMatchesConversation =
      (store.snapshot.conversationKey ?? activeCli.conversationKey ?? null) === conversationKey &&
      (store.snapshot.providerId ?? activeCli.providerId) === activeProviderId;

    if (backendMatchesProject && backendMatchesConversation) {
      requestedConversationKeyRef.current = requestKey;
      return;
    }

    if (requestedConversationKeyRef.current === requestKey) {
      return;
    }

    requestedConversationKeyRef.current = requestKey;
    void activateConversation(activeProject, activeProviderId, activeConversation);
  }, [activeCli, activeConversation, activeProject, activeProviderId, socketConnected, store.snapshot.conversationKey, store.snapshot.providerId]);

  async function refreshProjectConversations(
    project: ProjectEntry,
    providerId: ProviderId,
    cliId = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId)?.cliId ?? null
  ): Promise<ListProjectSessionsResultPayload> {
    const storageKey = getProjectProviderKey(project.id, providerId);
    const existingRequest = projectRefreshInFlightRef.current.get(storageKey);
    if (existingRequest) {
      return existingRequest;
    }
    if (!cliId) {
      throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
    }

    store.setProjectLoadingId(storageKey);

    const request = (async () => {
      try {
        const result = await sendCommand('list-project-conversations', { cwd: project.cwd, maxSessions: 5 }, cliId);
        const payload = result.payload as ListProjectSessionsResultPayload | undefined;
        const normalizedPayload = payload ?? {
          providerId,
          cwd: project.cwd,
          label: project.label,
          sessions: []
        };

        store.patchWorkspace((current) => ({
          ...current,
          projects: current.projects.map((entry) =>
            entry.id !== project.id
              ? entry
              : {
                  ...entry,
                  cwd: normalizedPayload.cwd,
                  label: normalizedPayload.label
                }
          )
        }));

        store.setProjectConversations(project.id, normalizedPayload.providerId, (conversations) =>
          mergeProjectConversations(conversations, normalizedPayload.sessions, normalizedPayload.providerId)
        );
        return normalizedPayload;
      } finally {
        projectRefreshInFlightRef.current.delete(storageKey);
        store.setProjectLoadingId((current) => (current === storageKey ? null : current));
      }
    })();

    projectRefreshInFlightRef.current.set(storageKey, request);
    return request;
  }

  async function refreshAllProjectConversations(): Promise<void> {
    if (store.projectsRefreshing || store.workspaceState.projects.length === 0) {
      return;
    }

    store.setProjectsRefreshing(true);

    try {
      store.setError('');
      const latestConversationsByKey = new Map<string, ProjectConversationEntry[]>(
        Object.entries(store.projectConversationsByKey)
      );
      let nextActiveConversationId: string | null | undefined;
      let refreshErrorMessage = '';

      for (const project of store.workspaceState.projects) {
        for (const providerId of connectedProviderIds) {
          try {
            const history = await refreshProjectConversations(project, providerId);
            const storageKey = getProjectProviderKey(project.id, providerId);
            const mergedConversations = mergeProjectConversations(
              latestConversationsByKey.get(storageKey) ?? [],
              history.sessions,
              providerId
            );
            latestConversationsByKey.set(storageKey, mergedConversations);

            if (project.id === store.workspaceState.activeProjectId && providerId === store.workspaceState.activeProviderId) {
              const activeCandidate =
                mergedConversations.find((conversation) => conversation.id === store.workspaceState.activeConversationId) ??
                mergedConversations.find((conversation) => conversation.sessionId === history.sessions[0]?.sessionId) ??
                mergedConversations[0] ??
                null;
              nextActiveConversationId = activeCandidate?.id ?? null;
            }
          } catch (refreshError) {
            refreshErrorMessage ||= refreshError instanceof Error ? refreshError.message : `刷新项目 ${project.label} 失败`;
          }
        }
      }

      if (nextActiveConversationId !== undefined) {
        store.patchWorkspace((current) =>
          current.activeConversationId === nextActiveConversationId
            ? current
            : { ...current, activeConversationId: nextActiveConversationId }
        );
      }

      if (refreshErrorMessage) {
        store.setError(refreshErrorMessage);
      }
    } finally {
      store.setProjectsRefreshing(false);
    }
  }

  async function activateConversation(
    project: ProjectEntry,
    providerId: ProviderId,
    conversation: ProjectConversationEntry
  ): Promise<void> {
    try {
      store.setError('');
      const targetCli = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId);
      if (!targetCli) {
        throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
      }

      requestedConversationKeyRef.current = `${targetCli.cliId}:${providerId}:${conversation.conversationKey}:${conversation.sessionId ?? 'draft'}`;
      if (conversation.sessionId === null) {
        store.resetRuntimeForDraftThread();
      }
      store.patchWorkspace((current) => ({
        ...current,
        activeCliId: targetCli.cliId,
        activeProjectId: project.id,
        activeProviderId: providerId,
        activeConversationId: conversation.id
      }));

      await sendCommand(
        'select-conversation',
        {
          cwd: project.cwd,
          conversationKey: conversation.conversationKey,
          sessionId: conversation.sessionId
        },
        targetCli.cliId
      );
      store.setMobilePane('chat');
    } catch (activateError) {
      requestedConversationKeyRef.current = null;
      store.setError(activateError instanceof Error ? activateError.message : '切换 conversation 失败');
    }
  }

  async function addProject(): Promise<void> {
    try {
      store.setError('');
      const targetCli =
        getConnectedCliForProvider(clis, activeProviderId, activeCliId) ?? clis.find((cli) => cli.connected) ?? null;
      if (!targetCli) {
        throw new Error('请先选择一个在线 CLI');
      }

      const result = await sendCommand('pick-project-directory', {}, targetCli.cliId);
      const payload = result.payload as PickProjectDirectoryResultPayload | undefined;
      if (!payload?.cwd) {
        return;
      }

      let selectedProject: ProjectEntry = {
        id: crypto.randomUUID(),
        cwd: payload.cwd,
        label: payload.label
      };

      store.patchWorkspace((current) => {
        const existingProject = current.projects.find((project) => project.cwd === payload.cwd);
        if (existingProject) {
          selectedProject = existingProject;
          return {
            ...current,
            activeCliId: targetCli.cliId,
            activeProjectId: existingProject.id,
            activeProviderId: targetCli.providerId
          };
        }

        return {
          ...current,
          activeCliId: targetCli.cliId,
          activeProjectId: selectedProject.id,
          activeProviderId: targetCli.providerId,
          activeConversationId: null,
          projects: sortProjects([...current.projects, selectedProject])
        };
      });

      const history = await refreshProjectConversations(selectedProject, targetCli.providerId, targetCli.cliId);
      const storageKey = getProjectProviderKey(selectedProject.id, targetCli.providerId);
      const existingConversations = store.projectConversationsByKey[storageKey] ?? [];
      const mergedConversations = mergeProjectConversations(
        existingConversations,
        history.sessions,
        targetCli.providerId
      );
      const resolvedConversations =
        mergedConversations.length > 0 ? mergedConversations : [createDraftConversation(targetCli.providerId)];
      const nextConversation =
        resolvedConversations.find((conversation) => conversation.sessionId === history.sessions[0]?.sessionId) ??
        resolvedConversations[0] ??
        null;

      store.setProjectConversations(selectedProject.id, targetCli.providerId, () => resolvedConversations);

      if (nextConversation) {
        await activateConversation(selectedProject, targetCli.providerId, nextConversation);
      }
    } catch (addProjectError) {
      store.setError(addProjectError instanceof Error ? addProjectError.message : '添加项目失败');
    }
  }

  function selectCli(nextCliId: string | null): void {
    const nextCli = clis.find((cli) => cli.cliId === nextCliId) ?? null;
    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextCliId,
      activeProviderId: nextCli?.providerId ?? current.activeProviderId,
      activeConversationId: nextCli && nextCli.providerId !== current.activeProviderId ? null : current.activeConversationId
    }));
  }

  function selectProject(project: ProjectEntry): void {
    store.patchWorkspace((current) => ({
      ...current,
      activeProjectId: project.id
    }));
  }

  function selectProvider(project: ProjectEntry, providerId: ProviderId): void {
    const targetCli = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId);
    const conversations = store.projectConversationsByKey[getProjectProviderKey(project.id, providerId)] ?? [];

    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: targetCli?.cliId ?? current.activeCliId,
      activeProjectId: project.id,
      activeProviderId: providerId,
      activeConversationId:
        current.activeProjectId === project.id && current.activeProviderId === providerId
          ? current.activeConversationId
          : conversations[0]?.id ?? null
    }));
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    store.patchWorkspace((current) => ({ ...current, sidebarCollapsed: collapsed }));
  }

  async function submitPrompt(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const content = store.prompt.trim();
    if (!content) {
      store.setError('请输入消息');
      return;
    }
    if (!activeProject || !activeConversation || !activeProviderId) {
      store.setError('请先在侧边栏选择一个 project / provider / conversation');
      return;
    }

    try {
      store.setError('');
      await sendCommand('send-message', { content });
      store.setPrompt('');
      store.setMobilePane('chat');
    } catch (submitError) {
      store.setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function stopMessage(): Promise<void> {
    try {
      store.setError('');
      await sendCommand('stop-message', {});
    } catch (stopError) {
      store.setError(stopError instanceof Error ? stopError.message : '结束失败');
    }
  }

  async function loadOlderMessages(beforeMessageId: string | undefined): Promise<boolean> {
    try {
      store.setError('');
      store.setOlderMessagesLoading(true);

      const result = await sendCommand('get-older-messages', {
        beforeMessageId,
        maxMessages: 40
      });
      const payload = result.payload as GetOlderMessagesResultPayload | undefined;

      if (
        (payload?.providerId ?? null) !== store.snapshot.providerId ||
        (payload?.conversationKey ?? null) !== store.snapshot.conversationKey
      ) {
        return false;
      }

      store.mergeOlderMessages(payload?.messages ?? [], Boolean(payload?.hasOlderMessages));
      return Boolean(payload?.messages?.length);
    } catch (loadError) {
      store.setError(loadError instanceof Error ? loadError.message : '加载更早消息失败');
      return false;
    } finally {
      store.setOlderMessagesLoading(false);
    }
  }

  return {
    activateConversation,
    addProject,
    loadOlderMessages,
    refreshAllProjectConversations,
    selectCli,
    selectProject,
    selectProvider,
    setSidebarCollapsed,
    stopMessage,
    submitPrompt
  };
}
