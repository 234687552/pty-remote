import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';

import type {
  GetOlderMessagesResultPayload,
  GetRuntimeSnapshotResultPayload,
  ListProjectSessionsResultPayload,
  MessagesUpsertPayload,
  PickProjectDirectoryResultPayload,
  TerminalChunkPayload
} from '@shared/protocol.ts';
import type { CliDescriptor, ChatMessage, RuntimeSnapshot } from '@shared/runtime-types.ts';

import type { CliSocketController } from '@/hooks/useCliSocket.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';
import {
  createEmptySnapshot,
  mergeChronologicalMessages
} from '@/lib/runtime.ts';
import {
  clampSidebarToggleTop,
  createDraftThread,
  hydrateThreadFromSnapshot,
  mergeProjectThreads,
  sortProjects,
  sortThreads,
  type ProjectEntry,
  type ProjectThreadEntry
} from '@/lib/workspace.ts';

import {
  selectWorkspaceDerivedState
} from './selectors.ts';
import type { WorkspaceStore } from './store.ts';

export interface WorkspaceController {
  activateThread: (project: ProjectEntry, thread: ProjectThreadEntry) => Promise<void>;
  addProject: () => Promise<void>;
  createThread: (projectId: string) => void;
  loadOlderMessages: (beforeMessageId: string | undefined) => Promise<boolean>;
  refreshAllProjectThreads: () => Promise<void>;
  selectCli: (cliId: string | null) => void;
  selectProject: (project: ProjectEntry, firstThreadId: string | null) => void;
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

export function useWorkspaceController({
  clis,
  sendCommand,
  socketConnected,
  store,
  terminal
}: UseWorkspaceControllerParams): WorkspaceController {
  const requestedThreadKeyRef = useRef<string | null>(null);
  const sidebarRefreshTriggeredRef = useRef(false);
  const previousSidebarCollapsedRef = useRef(store.workspaceState.sidebarCollapsed);
  const sidebarToggleTopRef = useRef(store.sidebarToggleTop);

  const {
    activeCli,
    activeCliId,
    activeProject,
    activeProjectThreads,
    activeThread,
    visibleMessages
  } = useMemo(
    () => selectWorkspaceDerivedState(store, clis, socketConnected),
    [
      clis,
      socketConnected,
      store.olderMessages,
      store.projectThreadsById,
      store.snapshot,
      store.workspaceState
    ]
  );

  sidebarToggleTopRef.current = store.sidebarToggleTop;

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
  }, [store.mobilePane]);

  useEffect(() => {
    terminal.scheduleResize();
  }, [store.workspaceState.sidebarCollapsed]);

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
    if (clis.length !== 1 && store.workspaceState.activeCliId) {
      return;
    }

    const soleCliId = clis[0]?.cliId ?? null;
    const hasUnassignedProjects = store.workspaceState.projects.some((project) => !project.cliId);
    if (!soleCliId && !hasUnassignedProjects) {
      return;
    }

    store.patchWorkspace((current) => {
      const nextCliId = current.activeCliId ?? soleCliId;
      const nextProjects = current.projects.map((project) => (project.cliId ? project : { ...project, cliId: soleCliId ?? project.cliId }));
      const changed =
        nextCliId !== current.activeCliId ||
        nextProjects.some((project, index) => project.cliId !== current.projects[index]?.cliId);
      return changed ? { ...current, activeCliId: nextCliId, projects: nextProjects } : current;
    });
  }, [clis, store.workspaceState.activeCliId, store.workspaceState.projects]);

  useEffect(() => {
    if (activeProject && store.workspaceState.activeCliId !== activeProject.cliId) {
      store.patchWorkspace((current) =>
        current.activeProjectId === activeProject.id && current.activeCliId !== activeProject.cliId
          ? { ...current, activeCliId: activeProject.cliId }
          : current
      );
      return;
    }

    if (store.workspaceState.activeCliId || clis.length === 0) {
      return;
    }

    store.patchWorkspace((current) => (current.activeCliId ? current : { ...current, activeCliId: clis[0]?.cliId ?? null }));
  }, [activeProject, clis, store.workspaceState.activeCliId]);

  useEffect(() => {
    if (!activeProject || activeProjectThreads.length === 0 || activeThread) {
      return;
    }

    store.patchWorkspace((current) =>
      current.activeProjectId === activeProject.id && current.activeThreadId !== activeProjectThreads[0]?.id
        ? { ...current, activeThreadId: activeProjectThreads[0]?.id ?? null }
        : current
    );
  }, [activeProject, activeProjectThreads, activeThread]);

  useEffect(() => {
    if (!activeProject || !activeThread || !activeCli) {
      return;
    }

    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const canHydrateFromSnapshot = backendMatchesProject && store.snapshot.threadKey === activeThread.threadKey;
    if (!canHydrateFromSnapshot) {
      return;
    }

    store.setProjectThreads(activeProject.id, (threads) => {
      let changed = false;
      const nextThreads = threads.map((thread) => {
        if (thread.id !== activeThread.id) {
          return thread;
        }

        const nextThread = hydrateThreadFromSnapshot(thread, store.snapshot, visibleMessages);
        const shouldUpdate =
          thread.sessionId !== nextThread.sessionId ||
          thread.title !== nextThread.title ||
          thread.preview !== nextThread.preview ||
          thread.updatedAt !== nextThread.updatedAt ||
          thread.messageCount !== nextThread.messageCount ||
          thread.draft !== nextThread.draft;

        if (!shouldUpdate) {
          return thread;
        }

        changed = true;
        return nextThread;
      });

      return changed ? sortThreads(nextThreads) : threads;
    });
  }, [activeCli, activeProject, activeThread, store.snapshot.sessionId, store.snapshot.threadKey, visibleMessages]);

  useEffect(() => {
    if (!socketConnected || !activeCliId) {
      store.resetRuntimeForCliChange();
      terminal.clearTerminal();
      return;
    }

    terminal.prepareForResume();
    store.resetRuntimeForCliChange();

    void sendCommand('get-runtime-snapshot', {}, activeCliId)
      .then(async (result) => {
        const nextSnapshot = (result.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
        store.setSnapshot(nextSnapshot);
        await terminal.resumeSession(nextSnapshot.sessionId, { force: true });
      })
      .catch((runtimeError) => {
        terminal.clearTerminal();
        store.setError(runtimeError instanceof Error ? runtimeError.message : '加载 CLI 运行态失败');
      });
  }, [activeCliId, socketConnected]);

  useEffect(() => {
    if (!socketConnected || store.workspaceState.sidebarCollapsed || store.projectsRefreshing) {
      return;
    }

    const nextProjectToLoad = store.workspaceState.projects.find(
      (project) => project.cliId && !store.projectThreadsById[project.id] && store.projectLoadingId !== project.id
    );
    if (!nextProjectToLoad) {
      return;
    }

    void refreshProjectThreads(nextProjectToLoad);
  }, [
    socketConnected,
    store.projectLoadingId,
    store.projectThreadsById,
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
    void refreshAllProjectThreads();
  }, [
    store.projectLoadingId,
    store.projectsRefreshing,
    store.workspaceState.projects.length,
    store.workspaceState.sidebarCollapsed
  ]);

  useEffect(() => {
    if (!socketConnected || !activeCli?.connected || !activeProject || !activeThread) {
      return;
    }

    const threadKey = activeThread.threadKey;
    const requestKey = `${activeProject.cliId}:${threadKey}:${activeThread.sessionId ?? 'draft'}`;
    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const backendMatchesThread = (store.snapshot.threadKey ?? activeCli.threadKey ?? null) === threadKey;

    if (backendMatchesProject && backendMatchesThread) {
      requestedThreadKeyRef.current = requestKey;
      return;
    }

    if (requestedThreadKeyRef.current === requestKey) {
      return;
    }

    requestedThreadKeyRef.current = requestKey;
    void activateThread(activeProject, activeThread);
  }, [activeCli, activeProject, activeThread, socketConnected, store.snapshot.threadKey]);

  async function refreshProjectThreads(project: ProjectEntry): Promise<ListProjectSessionsResultPayload> {
    store.setProjectLoadingId(project.id);

    try {
      const result = await sendCommand('list-project-sessions', { cwd: project.cwd, maxSessions: 5 }, project.cliId);
      const payload = result.payload as ListProjectSessionsResultPayload | undefined;
      const normalizedPayload = payload ?? {
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

      store.setProjectThreads(project.id, (threads) => mergeProjectThreads(threads, normalizedPayload.sessions));
      return normalizedPayload;
    } finally {
      store.setProjectLoadingId((current) => (current === project.id ? null : current));
    }
  }

  async function refreshAllProjectThreads(): Promise<void> {
    if (store.projectsRefreshing || store.workspaceState.projects.length === 0) {
      return;
    }

    store.setProjectsRefreshing(true);

    try {
      store.setError('');
      const latestThreadsByProject = new Map<string, ProjectThreadEntry[]>(
        Object.entries(store.projectThreadsById).map(([projectId, threads]) => [projectId, threads])
      );
      let nextActiveThreadId: string | null | undefined;
      let refreshErrorMessage = '';

      for (const project of store.workspaceState.projects) {
        if (!project.cliId) {
          continue;
        }

        try {
          const history = await refreshProjectThreads(project);
          const mergedThreads = mergeProjectThreads(latestThreadsByProject.get(project.id) ?? [], history.sessions);
          latestThreadsByProject.set(project.id, mergedThreads);

          if (project.id === store.workspaceState.activeProjectId) {
            const activeCandidate =
              mergedThreads.find((thread) => thread.id === store.workspaceState.activeThreadId) ??
              mergedThreads.find((thread) => thread.sessionId === history.sessions[0]?.sessionId) ??
              mergedThreads[0] ??
              null;
            nextActiveThreadId = activeCandidate?.id ?? null;
          }
        } catch (refreshError) {
          refreshErrorMessage ||= refreshError instanceof Error ? refreshError.message : `刷新项目 ${project.label} 失败`;
        }
      }

      if (nextActiveThreadId !== undefined) {
        store.patchWorkspace((current) =>
          current.activeThreadId === nextActiveThreadId ? current : { ...current, activeThreadId: nextActiveThreadId }
        );
      }

      if (refreshErrorMessage) {
        store.setError(refreshErrorMessage);
      }
    } finally {
      store.setProjectsRefreshing(false);
    }
  }

  async function activateThread(project: ProjectEntry, thread: ProjectThreadEntry): Promise<void> {
    try {
      store.setError('');
      requestedThreadKeyRef.current = `${project.cliId}:${thread.threadKey}:${thread.sessionId ?? 'draft'}`;
      if (thread.sessionId === null) {
        store.resetRuntimeForDraftThread();
      }
      store.patchWorkspace((current) => ({
        ...current,
        activeCliId: project.cliId,
        activeProjectId: project.id,
        activeThreadId: thread.id
      }));

      await sendCommand(
        'select-thread',
        {
          cwd: project.cwd,
          threadKey: thread.threadKey,
          sessionId: thread.sessionId
        },
        project.cliId
      );
      store.setMobilePane('chat');
    } catch (activateError) {
      requestedThreadKeyRef.current = null;
      store.setError(activateError instanceof Error ? activateError.message : '切换 thread 失败');
    }
  }

  async function addProject(): Promise<void> {
    try {
      store.setError('');
      const targetCliId = activeCliId ?? clis[0]?.cliId ?? null;
      if (!targetCliId) {
        throw new Error('请先选择一个在线 CLI');
      }

      const result = await sendCommand('pick-project-directory', {}, targetCliId);
      const payload = result.payload as PickProjectDirectoryResultPayload | undefined;
      if (!payload?.cwd) {
        return;
      }

      let selectedProject: ProjectEntry = {
        id: crypto.randomUUID(),
        cliId: targetCliId,
        cwd: payload.cwd,
        label: payload.label
      };

      store.patchWorkspace((current) => {
        const existingProject = current.projects.find((project) => project.cliId === targetCliId && project.cwd === payload.cwd);
        if (existingProject) {
          selectedProject = existingProject;
          return {
            ...current,
            activeCliId: existingProject.cliId,
            activeProjectId: existingProject.id,
            activeThreadId: current.activeThreadId
          };
        }

        return {
          ...current,
          activeCliId: targetCliId,
          activeProjectId: selectedProject.id,
          activeThreadId: null,
          projects: sortProjects([...current.projects, selectedProject])
        };
      });

      const history = await refreshProjectThreads(selectedProject);
      const draftThread = createDraftThread();
      const nextThreads = mergeProjectThreads(store.projectThreadsById[selectedProject.id] ?? [], history.sessions);
      const resolvedThreads = nextThreads.length > 0 ? nextThreads : [draftThread];
      const nextThread = resolvedThreads.find((thread) => thread.sessionId === history.sessions[0]?.sessionId) ?? resolvedThreads[0];
      store.setProjectThreads(selectedProject.id, () => resolvedThreads);

      if (nextThread) {
        await activateThread(selectedProject, nextThread);
      }
    } catch (addProjectError) {
      store.setError(addProjectError instanceof Error ? addProjectError.message : '添加项目失败');
    }
  }

  function createThread(projectId: string): void {
    const nextProject = store.workspaceState.projects.find((project) => project.id === projectId) ?? null;
    const nextThread = createDraftThread();
    store.setProjectThreads(projectId, (threads) => sortThreads([nextThread, ...threads]));
    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextProject?.cliId ?? current.activeCliId,
      activeProjectId: projectId,
      activeThreadId: nextThread.id
    }));

    if (nextProject) {
      void activateThread(nextProject, nextThread);
    }
  }

  function selectCli(nextCliId: string | null): void {
    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextCliId,
      activeProjectId:
        current.activeProjectId &&
        current.projects.find((project) => project.id === current.activeProjectId)?.cliId === nextCliId
          ? current.activeProjectId
          : current.projects.find((project) => project.cliId === nextCliId)?.id ?? null,
      activeThreadId: null
    }));
  }

  function selectProject(project: ProjectEntry, firstThreadId: string | null): void {
    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: project.cliId,
      activeProjectId: project.id,
      activeThreadId: firstThreadId ?? current.activeThreadId
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
    if (!activeProject || !activeThread) {
      store.setError('请先在侧边栏选择一个 project / thread');
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

      if ((payload?.threadKey ?? null) !== store.snapshot.threadKey) {
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
    activateThread,
    addProject,
    createThread,
    loadOlderMessages,
    refreshAllProjectThreads,
    selectCli,
    selectProject,
    setSidebarCollapsed,
    stopMessage,
    submitPrompt
  };
}
