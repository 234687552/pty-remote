import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';

import type {
  GetOlderMessagesResultPayload,
  GetRuntimeSnapshotResultPayload,
  ListProjectSessionsResultPayload,
  PickProjectDirectoryResultPayload,
  SelectConversationResultPayload
} from '@shared/protocol.ts';
import { PROVIDER_LABELS, type CliDescriptor, type ProviderId, type RuntimeSnapshot } from '@shared/runtime-types.ts';

import type { CliSocketController } from '@/hooks/useCliSocket.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';
import { createEmptySnapshot } from '@/lib/runtime.ts';
import { readConversationCache } from '@/lib/messages-cache.ts';
import {
  clampSidebarToggleTop,
  createDraftConversation,
  getProjectProviderKey,
  getThreadLabel,
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
  addProject: (input: { cwd: string; providerId: ProviderId }) => Promise<void>;
  deleteProject: (project: ProjectEntry) => Promise<void>;
  loadOlderMessages: (beforeMessageId: string | undefined) => Promise<boolean>;
  pickProjectDirectory: (providerId: ProviderId) => Promise<string | null>;
  refreshProjectConversations: (project: ProjectEntry, providerId: ProviderId) => Promise<void>;
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

function supportsProvider(cli: CliDescriptor, providerId: ProviderId | null): boolean {
  return providerId !== null && cli.supportedProviders.includes(providerId);
}

function getCliRuntimeState(cli: CliDescriptor | null, providerId: ProviderId | null) {
  return providerId ? cli?.runtimes[providerId] ?? null : null;
}

function getConnectedCliForProvider(
  clis: CliDescriptor[],
  providerId: ProviderId | null,
  preferredCliId: string | null
): CliDescriptor | null {
  if (!providerId) {
    return null;
  }

  const candidates = clis.filter((cli) => cli.connected && supportsProvider(cli, providerId));
  if (candidates.length === 0) {
    return null;
  }

  return candidates.find((cli) => cli.cliId === preferredCliId) ?? candidates[0] ?? null;
}

function getProviderIds(clis: CliDescriptor[]): ProviderId[] {
  return [...new Set(clis.filter((cli) => cli.connected).flatMap((cli) => cli.supportedProviders))];
}

export function useWorkspaceController({
  clis,
  sendCommand,
  socketConnected,
  store,
  terminal
}: UseWorkspaceControllerParams): WorkspaceController {
  const projectRefreshInFlightRef = useRef(new Map<string, Promise<ListProjectSessionsResultPayload>>());
  const conversationActivationRef = useRef<
    { status: 'idle' } | { requestId: number; requestKey: string; requestToken: string; status: 'selecting' }
  >({ status: 'idle' });
  const conversationActivationSeqRef = useRef(0);
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

  sidebarToggleTopRef.current = store.sidebarToggleTop;

  useEffect(() => {
    if (!socketConnected) {
      return;
    }

    void terminal.resumeSession(activeConversation?.sessionId ?? null);
  }, [activeConversation?.sessionId, socketConnected, terminal]);

  useEffect(() => {
    if (!activeConversation || !activeProviderId) {
      return;
    }
    if (
      store.snapshot.providerId === activeProviderId &&
      store.snapshot.conversationKey === activeConversation.conversationKey
    ) {
      return;
    }

    const cached = readConversationCache(
      activeProviderId,
      activeConversation.conversationKey,
      activeConversation.sessionId
    );
    if (!cached || cached.messages.length === 0) {
      return;
    }

    const cachedSnapshot: RuntimeSnapshot = {
      providerId: activeProviderId,
      conversationKey: activeConversation.conversationKey,
      sessionId: activeConversation.sessionId ?? cached.sessionId ?? null,
      status: 'idle',
      messages: cached.messages,
      hasOlderMessages: activeConversation.messageCount > cached.messages.length,
      lastError: null
    };
    store.setSnapshot(cachedSnapshot);
  }, [activeConversation, activeProviderId, store, store.snapshot.conversationKey, store.snapshot.providerId]);

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
      const nextProviderId =
        current.activeProviderId && supportsProvider(fallbackCli, current.activeProviderId)
          ? current.activeProviderId
          : fallbackCli.supportedProviders[0] ?? null;
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

    const activeRuntime = getCliRuntimeState(activeCli, activeProviderId);
    const backendMatchesProject = (activeRuntime?.cwd ?? activeCli.cwd) === activeProject.cwd;
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
      terminal.clearTerminal();
      return;
    }

    terminal.prepareForResume();
    store.resetRuntimeForCliChange();

      void sendCommand('get-runtime-snapshot', {}, activeCliId, activeProviderId)
      .then(async (result) => {
        const nextSnapshot = (result.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
        store.setSnapshot(nextSnapshot);
        await terminal.resumeSession(activeConversation?.sessionId ?? null, { force: true });
      })
      .catch((runtimeError) => {
        terminal.clearTerminal();
        store.setError(runtimeError instanceof Error ? runtimeError.message : '加载 CLI 运行态失败');
      });
  }, [activeCliConnected, activeCliId, activeConversation?.sessionId, activeProviderId, sendCommand, socketConnected, terminal]);

  useEffect(() => {
    if (!socketConnected || !activeCli?.connected || !activeProject || !activeConversation || !activeProviderId) {
      return;
    }

    const conversationKey = activeConversation.conversationKey;
    const requestKey = `${activeCli.cliId}:${activeProviderId}:${conversationKey}:${activeConversation.sessionId ?? 'draft'}`;
    const activeRuntime = getCliRuntimeState(activeCli, activeProviderId);
    const backendMatchesProject = (activeRuntime?.cwd ?? activeCli.cwd) === activeProject.cwd;
    const backendMatchesConversation =
      (store.snapshot.conversationKey ?? activeRuntime?.conversationKey ?? null) === conversationKey &&
      (store.snapshot.providerId ?? activeProviderId) === activeProviderId;
    const activationState = conversationActivationRef.current;

    if (backendMatchesProject && backendMatchesConversation) {
      if (activationState.status === 'selecting' && activationState.requestKey === requestKey) {
        conversationActivationRef.current = { status: 'idle' };
      }
      return;
    }

    if (activationState.status === 'selecting' && activationState.requestKey === requestKey) {
      return;
    }

    void activateConversation(activeProject, activeProviderId, activeConversation, { requestKey });
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
        const result = await sendCommand('list-project-conversations', { cwd: project.cwd, maxSessions: 5 }, cliId, providerId);
        const payload = result.payload as ListProjectSessionsResultPayload | undefined;
        const normalizedPayload = payload ?? {
          providerId,
          cwd: project.cwd,
          label: project.label,
          sessions: []
        };

        store.patchWorkspace((current) => {
          let changed = false;
          const nextProjects = current.projects.map((entry) => {
            if (entry.id !== project.id) {
              return entry;
            }
            if (entry.cwd === normalizedPayload.cwd && entry.label === normalizedPayload.label) {
              return entry;
            }
            changed = true;
            return {
              ...entry,
              cwd: normalizedPayload.cwd,
              label: normalizedPayload.label
            };
          });

          return changed
            ? {
                ...current,
                projects: nextProjects
              }
            : current;
        });

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

  async function refreshProjectConversationList(project: ProjectEntry, providerId: ProviderId): Promise<void> {
    try {
      store.setError('');
      await refreshProjectConversations(project, providerId);
    } catch (refreshError) {
      store.setError(refreshError instanceof Error ? refreshError.message : `刷新项目 ${project.label} 失败`);
    }
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
    conversation: ProjectConversationEntry,
    options?: { requestKey?: string; requestToken?: string }
  ): Promise<void> {
    let requestId: number | null = null;
    let requestToken: string | null = null;
    try {
      store.setError('');
      const targetCli = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId);
      if (!targetCli) {
        throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
      }

      const requestKey =
        options?.requestKey ??
        `${targetCli.cliId}:${providerId}:${conversation.conversationKey}:${conversation.sessionId ?? 'draft'}`;
      requestToken = options?.requestToken ?? `select-${targetCli.cliId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      requestId = conversationActivationSeqRef.current + 1;
      conversationActivationSeqRef.current = requestId;
      conversationActivationRef.current = {
        status: 'selecting',
        requestId,
        requestKey,
        requestToken
      };

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

      const cached = readConversationCache(providerId, conversation.conversationKey, conversation.sessionId);
      if (cached && cached.messages.length > 0) {
        const cachedSnapshot: RuntimeSnapshot = {
          providerId,
          conversationKey: conversation.conversationKey,
          sessionId: conversation.sessionId ?? cached.sessionId ?? null,
          status: 'idle',
          messages: cached.messages,
          hasOlderMessages: conversation.messageCount > cached.messages.length,
          lastError: null
        };
        store.setSnapshot(cachedSnapshot);
      }

      const result = await sendCommand(
        'select-conversation',
        {
          cwd: project.cwd,
          conversationKey: conversation.conversationKey,
          sessionId: conversation.sessionId,
          clientRequestId: requestToken
        },
        targetCli.cliId,
        providerId
      );
      const selectPayload = result.payload as SelectConversationResultPayload | undefined;
      const acknowledgedRequestToken = selectPayload?.clientRequestId ?? null;
      const activationState = conversationActivationRef.current;
      if (
        requestId !== null &&
        requestToken !== null &&
        activationState.status === 'selecting' &&
        activationState.requestId === requestId &&
        (acknowledgedRequestToken === null || acknowledgedRequestToken === requestToken)
      ) {
        conversationActivationRef.current = { status: 'idle' };
      }
      store.setMobilePane('chat');
    } catch (activateError) {
      const activationState = conversationActivationRef.current;
      if (
        requestId !== null &&
        requestToken !== null &&
        activationState.status === 'selecting' &&
        activationState.requestId === requestId &&
        activationState.requestToken === requestToken
      ) {
        conversationActivationRef.current = { status: 'idle' };
      }
      store.setError(activateError instanceof Error ? activateError.message : '切换 conversation 失败');
    }
  }

  async function addProject(input: { cwd: string; providerId: ProviderId }): Promise<void> {
    try {
      store.setError('');
      const normalizedCwd = input.cwd.trim();
      const selectedProviderId = input.providerId;
      if (!normalizedCwd) {
        throw new Error('目录路径不能为空');
      }

      const targetCli = getConnectedCliForProvider(clis, selectedProviderId, activeCliId);
      if (!targetCli) {
        throw new Error(`No connected CLI available for ${PROVIDER_LABELS[selectedProviderId]}`);
      }

      let selectedProject: ProjectEntry = {
        id: crypto.randomUUID(),
        cwd: normalizedCwd,
        label: getThreadLabel(normalizedCwd)
      };

      store.patchWorkspace((current) => {
        const existingProject = current.projects.find((project) => project.cwd === normalizedCwd);
        if (existingProject) {
          selectedProject = existingProject;
          return {
            ...current,
            activeCliId: targetCli.cliId,
            activeProjectId: existingProject.id,
            activeProviderId: selectedProviderId
          };
        }

        return {
          ...current,
          activeCliId: targetCli.cliId,
          activeProjectId: selectedProject.id,
          activeProviderId: selectedProviderId,
          activeConversationId: null,
          projects: sortProjects([...current.projects, selectedProject])
        };
      });

      const history = await refreshProjectConversations(selectedProject, selectedProviderId, targetCli.cliId);
      const storageKey = getProjectProviderKey(selectedProject.id, selectedProviderId);
      const existingConversations = store.projectConversationsByKey[storageKey] ?? [];
      const mergedConversations = mergeProjectConversations(
        existingConversations,
        history.sessions,
        selectedProviderId
      );
      const resolvedConversations =
        mergedConversations.length > 0 ? mergedConversations : [createDraftConversation(selectedProviderId)];
      const nextConversation =
        resolvedConversations.find((conversation) => conversation.sessionId === history.sessions[0]?.sessionId) ??
        resolvedConversations[0] ??
        null;

      store.setProjectConversations(selectedProject.id, selectedProviderId, () => resolvedConversations);

      if (nextConversation) {
        await activateConversation(selectedProject, selectedProviderId, nextConversation);
      }
    } catch (addProjectError) {
      const message = addProjectError instanceof Error ? addProjectError.message : '添加项目失败';
      store.setError(message);
      throw addProjectError instanceof Error ? addProjectError : new Error(message);
    }
  }

  async function deleteProject(project: ProjectEntry): Promise<void> {
    const deletingActiveProject = store.workspaceState.activeProjectId === project.id;
    const providerIds = new Set<ProviderId>(connectedProviderIds);

    for (const storageKey of Object.keys(store.projectConversationsByKey)) {
      if (!storageKey.startsWith(`${project.id}:`)) {
        continue;
      }
      providerIds.add(storageKey.split(':')[1] as ProviderId);
    }

    for (const storageKey of [...projectRefreshInFlightRef.current.keys()]) {
      if (storageKey.startsWith(`${project.id}:`)) {
        projectRefreshInFlightRef.current.delete(storageKey);
      }
    }

    for (const providerId of providerIds) {
      store.setProjectConversations(project.id, providerId, () => []);
    }

    store.patchWorkspace((current) => {
      const nextProjects = sortProjects(current.projects.filter((entry) => entry.id !== project.id));
      if (current.activeProjectId !== project.id) {
        return {
          ...current,
          projects: nextProjects
        };
      }

      const fallbackProject = nextProjects[0] ?? null;
      return {
        ...current,
        projects: nextProjects,
        activeProjectId: fallbackProject?.id ?? null,
        activeProviderId: fallbackProject ? current.activeProviderId : null,
        activeConversationId: null
      };
    });

    if (deletingActiveProject) {
      store.resetRuntimeForCliChange();
      terminal.clearTerminal();
    }
  }

  async function pickProjectDirectory(providerId: ProviderId): Promise<string | null> {
    const targetCli = getConnectedCliForProvider(clis, providerId, activeCliId);
    if (!targetCli) {
      throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
    }

    const result = await sendCommand('pick-project-directory', {}, targetCli.cliId, providerId);
    const payload = result.payload as PickProjectDirectoryResultPayload | undefined;
    return payload?.cwd?.trim() || null;
  }

  function selectCli(nextCliId: string | null): void {
    const nextCli = clis.find((cli) => cli.cliId === nextCliId) ?? null;
    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextCliId,
      activeProviderId:
        nextCli && current.activeProviderId && supportsProvider(nextCli, current.activeProviderId)
          ? current.activeProviderId
          : nextCli?.supportedProviders[0] ?? current.activeProviderId,
      activeConversationId:
        nextCli && current.activeProviderId && !supportsProvider(nextCli, current.activeProviderId)
          ? null
          : current.activeConversationId
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
      await sendCommand('send-message', { content }, undefined, activeProviderId);
      store.setPrompt('');
      store.setMobilePane('chat');
    } catch (submitError) {
      store.setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function stopMessage(): Promise<void> {
    try {
      store.setError('');
      await sendCommand('stop-message', {}, undefined, activeProviderId);
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
      }, undefined, activeProviderId);
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
    deleteProject,
    loadOlderMessages,
    pickProjectDirectory,
    refreshProjectConversations: refreshProjectConversationList,
    refreshAllProjectConversations,
    selectCli,
    selectProject,
    selectProvider,
    setSidebarCollapsed,
    stopMessage,
    submitPrompt
  };
}
