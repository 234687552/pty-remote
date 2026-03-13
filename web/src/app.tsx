import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  GetOlderMessagesResultPayload,
  GetRuntimeSnapshotResultPayload,
  ListProjectSessionsResultPayload,
  MessagesUpsertPayload,
  PickProjectDirectoryResultPayload,
  TerminalChunkPayload
} from '@shared/protocol.ts';
import type { ChatMessage, RuntimeSnapshot } from '@shared/runtime-types.ts';

import { Sidebar } from '@/components/Sidebar.tsx';
import { WorkspaceScreen, type WorkspacePane } from '@/components/WorkspaceScreen.tsx';
import { useCliSocket } from '@/hooks/useCliSocket.ts';
import { useTerminalBridge } from '@/hooks/useTerminalBridge.ts';
import { useWorkspaceStore } from '@/hooks/useWorkspaceStore.ts';
import {
  createEmptySnapshot,
  getRuntimeStatusLabel,
  isBusyStatus,
  isCliOfflineMessage,
  mergeChronologicalMessages
} from '@/lib/runtime.ts';
import {
  clampSidebarToggleTop,
  compactPreview,
  createDraftThread,
  hydrateThreadFromSnapshot,
  mergeProjectThreads,
  sortProjects,
  sortThreads,
  type ProjectEntry,
  type ProjectThreadEntry
} from '@/lib/workspace.ts';

function applyMessagesUpsert(current: RuntimeSnapshot, payload: MessagesUpsertPayload): RuntimeSnapshot {
  const isSameThread = current.threadKey === payload.threadKey;
  const baseSnapshot = isSameThread
    ? current
    : {
        ...current,
        threadKey: payload.threadKey,
        sessionId: payload.sessionId,
        messages: [],
        hasOlderMessages: false
      };

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

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
}

export function App() {
  const {
    workspaceState,
    projectThreadsById,
    sidebarToggleTop,
    patchWorkspace,
    setProjectThreads,
    setSidebarToggleTop,
    commitSidebarToggleTop
  } = useWorkspaceStore();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(createEmptySnapshot());
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [projectsRefreshing, setProjectsRefreshing] = useState(false);
  const [projectLoadingId, setProjectLoadingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [mobilePane, setMobilePane] = useState<WorkspacePane>('chat');

  const requestedThreadKeyRef = useRef<string | null>(null);
  const sidebarRefreshTriggeredRef = useRef(false);
  const previousSidebarCollapsedRef = useRef(workspaceState.sidebarCollapsed);
  const sidebarToggleTopRef = useRef(sidebarToggleTop);
  const terminalEventHandlersRef = useRef<{
    onConnect: () => void;
    onDisconnect: () => void;
    onTerminalChunk: (payload: TerminalChunkPayload) => void;
  }>({
    onConnect: () => undefined,
    onDisconnect: () => undefined,
    onTerminalChunk: () => undefined
  });

  const activeProject = useMemo(
    () => workspaceState.projects.find((project) => project.id === workspaceState.activeProjectId) ?? null,
    [workspaceState.activeProjectId, workspaceState.projects]
  );
  const activeCliId = activeProject?.cliId ?? workspaceState.activeCliId;

  const { socketConnected, clis, socketRef, sendCommand } = useCliSocket({
    activeCliId,
    onConnect: () => terminalEventHandlersRef.current.onConnect(),
    onDisconnect: () => terminalEventHandlersRef.current.onDisconnect(),
    onMessagesUpsert: (payload) => {
      setSnapshot((current) => applyMessagesUpsert(current, payload));
    },
    onSnapshot: (nextSnapshot) => {
      setSnapshot(nextSnapshot);
    },
    onTerminalChunk: (payload) => {
      terminalEventHandlersRef.current.onTerminalChunk(payload);
    }
  });

  const terminal = useTerminalBridge({
    activeCliId,
    socketRef,
    setError
  });

  terminalEventHandlersRef.current.onConnect = () => {
    terminal.handleSocketConnected();
    setError('');
  };
  terminalEventHandlersRef.current.onDisconnect = () => {
    terminal.handleSocketDisconnected();
  };
  terminalEventHandlersRef.current.onTerminalChunk = (payload) => {
    terminal.handleTerminalChunk(payload);
  };

  const visibleMessages = useMemo(
    () => mergeChronologicalMessages(olderMessages, snapshot.messages),
    [olderMessages, snapshot.messages]
  );
  const activeCli = useMemo(() => clis.find((cli) => cli.cliId === activeCliId) ?? null, [activeCliId, clis]);
  const activeProjectThreads = useMemo(
    () => (activeProject ? projectThreadsById[activeProject.id] ?? [] : []),
    [activeProject, projectThreadsById]
  );
  const activeThread = useMemo(
    () => activeProjectThreads.find((thread) => thread.id === workspaceState.activeThreadId) ?? activeProjectThreads[0] ?? null,
    [activeProjectThreads, workspaceState.activeThreadId]
  );
  const connected = Boolean(socketConnected && activeCli?.connected);
  const busy = isBusyStatus(snapshot.status);
  const canSend = connected && !busy && Boolean(activeProject && activeThread);
  const canStop = connected && busy && Boolean(activeProject && activeThread);

  sidebarToggleTopRef.current = sidebarToggleTop;

  useEffect(() => {
    if (!socketConnected) {
      return;
    }

    void terminal.resumeSession(snapshot.sessionId);
  }, [snapshot.sessionId, socketConnected]);

  useEffect(() => {
    setOlderMessages([]);
    setHasOlderMessages(snapshot.hasOlderMessages);
    setOlderMessagesLoading(false);
  }, [snapshot.sessionId]);

  useEffect(() => {
    if (olderMessages.length > 0) {
      return;
    }
    setHasOlderMessages(snapshot.hasOlderMessages);
  }, [olderMessages.length, snapshot.hasOlderMessages]);

  useEffect(() => {
    if (mobilePane === 'terminal') {
      terminal.scheduleResize();
    }
  }, [mobilePane]);

  useEffect(() => {
    terminal.scheduleResize();
  }, [workspaceState.sidebarCollapsed]);

  useEffect(() => {
    const handleResize = () => {
      const nextTop = clampSidebarToggleTop(sidebarToggleTopRef.current, window.innerHeight);
      setSidebarToggleTop(nextTop);
      patchWorkspace((current) => {
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
    if (clis.length !== 1 && workspaceState.activeCliId) {
      return;
    }

    const soleCliId = clis[0]?.cliId ?? null;
    const hasUnassignedProjects = workspaceState.projects.some((project) => !project.cliId);
    if (!soleCliId && !hasUnassignedProjects) {
      return;
    }

    patchWorkspace((current) => {
      const nextCliId = current.activeCliId ?? soleCliId;
      const nextProjects = current.projects.map((project) => (project.cliId ? project : { ...project, cliId: soleCliId ?? project.cliId }));
      const changed =
        nextCliId !== current.activeCliId ||
        nextProjects.some((project, index) => project.cliId !== current.projects[index]?.cliId);
      return changed ? { ...current, activeCliId: nextCliId, projects: nextProjects } : current;
    });
  }, [clis, workspaceState.activeCliId, workspaceState.projects]);

  useEffect(() => {
    if (activeProject && workspaceState.activeCliId !== activeProject.cliId) {
      patchWorkspace((current) =>
        current.activeProjectId === activeProject.id && current.activeCliId !== activeProject.cliId
          ? { ...current, activeCliId: activeProject.cliId }
          : current
      );
      return;
    }

    if (workspaceState.activeCliId || clis.length === 0) {
      return;
    }

    patchWorkspace((current) => (current.activeCliId ? current : { ...current, activeCliId: clis[0]?.cliId ?? null }));
  }, [activeProject, clis, workspaceState.activeCliId]);

  useEffect(() => {
    if (!activeProject || activeProjectThreads.length === 0 || activeThread) {
      return;
    }

    patchWorkspace((current) =>
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
    const canHydrateFromSnapshot = backendMatchesProject && snapshot.threadKey === activeThread.threadKey;
    if (!canHydrateFromSnapshot) {
      return;
    }

    setProjectThreads(activeProject.id, (threads) => {
      let changed = false;
      const nextThreads = threads.map((thread) => {
        if (thread.id !== activeThread.id) {
          return thread;
        }

        const nextThread = hydrateThreadFromSnapshot(thread, snapshot, visibleMessages);
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
  }, [activeCli, activeProject, activeThread, snapshot.sessionId, snapshot.threadKey, visibleMessages]);

  useEffect(() => {
    if (!socketConnected || !activeCliId) {
      setSnapshot(createEmptySnapshot());
      terminal.clearTerminal();
      return;
    }

    terminal.prepareForResume();
    setSnapshot(createEmptySnapshot());
    setOlderMessages([]);
    setHasOlderMessages(false);
    setOlderMessagesLoading(false);

    void sendCommand('get-runtime-snapshot', {}, activeCliId)
      .then(async (result) => {
        const nextSnapshot = (result.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
        setSnapshot(nextSnapshot);
        await terminal.resumeSession(nextSnapshot.sessionId, { force: true });
      })
      .catch((runtimeError) => {
        terminal.clearTerminal();
        setError(runtimeError instanceof Error ? runtimeError.message : '加载 CLI 运行态失败');
      });
  }, [activeCliId, socketConnected]);

  useEffect(() => {
    if (!socketConnected || workspaceState.sidebarCollapsed || projectsRefreshing) {
      return;
    }

    const nextProjectToLoad = workspaceState.projects.find(
      (project) => project.cliId && !projectThreadsById[project.id] && projectLoadingId !== project.id
    );
    if (!nextProjectToLoad) {
      return;
    }

    void refreshProjectThreads(nextProjectToLoad);
  }, [projectLoadingId, projectThreadsById, projectsRefreshing, socketConnected, workspaceState.projects, workspaceState.sidebarCollapsed]);

  useEffect(() => {
    const wasCollapsed = previousSidebarCollapsedRef.current;
    previousSidebarCollapsedRef.current = workspaceState.sidebarCollapsed;

    if (workspaceState.sidebarCollapsed || workspaceState.projects.length === 0 || projectLoadingId || projectsRefreshing) {
      return;
    }

    if (!wasCollapsed && sidebarRefreshTriggeredRef.current) {
      return;
    }

    sidebarRefreshTriggeredRef.current = true;
    void refreshAllProjectThreads();
  }, [projectLoadingId, projectsRefreshing, workspaceState.projects.length, workspaceState.sidebarCollapsed]);

  useEffect(() => {
    if (!socketConnected || !activeCli?.connected || !activeProject || !activeThread) {
      return;
    }

    const threadKey = activeThread.threadKey;
    const requestKey = `${activeProject.cliId}:${threadKey}:${activeThread.sessionId ?? 'draft'}`;
    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const backendMatchesThread = (snapshot.threadKey ?? activeCli.threadKey ?? null) === threadKey;

    if (backendMatchesProject && backendMatchesThread) {
      requestedThreadKeyRef.current = requestKey;
      return;
    }

    if (requestedThreadKeyRef.current === requestKey) {
      return;
    }

    requestedThreadKeyRef.current = requestKey;
    void activateThread(activeProject, activeThread);
  }, [activeCli, activeProject, activeThread, snapshot.threadKey, socketConnected]);

  const footerErrorText = useMemo(() => {
    if (error && !isCliOfflineMessage(error)) {
      return error;
    }
    if (snapshot.lastError && !isCliOfflineMessage(snapshot.lastError)) {
      return snapshot.lastError;
    }
    return '';
  }, [error, snapshot.lastError]);

  const headerSummary = useMemo(
    () => [
      `CLI ${compactPreview(activeCli?.label ?? 'unselected', 28)}`,
      `项目 ${compactPreview(activeProject?.label ?? activeCli?.label ?? 'Workspace', 28)}`,
      `目录 ${compactPreview(activeProject?.cwd ?? activeCli?.cwd ?? '-', 56)}`,
      `线程 ${compactPreview(activeThread?.title ?? '-', 36)}`,
      `会话 ${compactPreview(activeThread?.sessionId ?? snapshot.sessionId ?? '-', 24)}`
    ],
    [activeCli?.cwd, activeCli?.label, activeProject?.cwd, activeProject?.label, activeThread?.sessionId, activeThread?.title, snapshot.sessionId]
  );

  const conversationBadge = useMemo(() => {
    if (!activeProject || !activeThread) {
      return {
        label: 'conversation',
        value: 'unselected',
        className: 'bg-zinc-100 text-zinc-600'
      };
    }

    if (snapshot.status === 'error') {
      return {
        label: 'conversation',
        value: 'error',
        className: 'bg-red-100 text-red-700'
      };
    }

    if (busy) {
      return {
        label: 'conversation',
        value: getRuntimeStatusLabel(snapshot.status),
        className: 'bg-zinc-900 text-white'
      };
    }

    return {
      label: 'conversation',
      value: getRuntimeStatusLabel(snapshot.status),
      className: 'bg-white/85 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]'
    };
  }, [activeProject, activeThread, busy, snapshot.status]);

  const socketBadge = useMemo(
    () => ({
      label: 'socket',
      value: socketConnected ? 'online' : 'offline',
      className: socketConnected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
    }),
    [socketConnected]
  );

  const cliBadge = useMemo(() => {
    if (!activeCliId) {
      return {
        label: 'cli',
        value: 'unselected',
        className: 'bg-zinc-100 text-zinc-600'
      };
    }

    return {
      label: 'cli',
      value: activeCli?.connected ? 'online' : 'offline',
      className: activeCli?.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
    };
  }, [activeCli?.connected, activeCliId]);

  const composerPlaceholder = !activeProject
    ? '先从左侧添加并选择一个 project / thread。'
    : !connected
      ? '等待 CLI 连接...'
      : snapshot.status === 'starting'
        ? 'Claude 正在启动...'
        : snapshot.status === 'running'
          ? 'Claude 正在运行...'
          : snapshot.status === 'error'
            ? '上次运行出错，可继续输入或切到别的 thread。'
            : activeThread?.draft
              ? '这是一个新 thread，第一条消息会创建新 session。'
              : '输入消息，继续这个 thread。';

  async function refreshProjectThreads(project: ProjectEntry): Promise<ListProjectSessionsResultPayload> {
    setProjectLoadingId(project.id);

    try {
      const result = await sendCommand('list-project-sessions', { cwd: project.cwd, maxSessions: 5 }, project.cliId);
      const payload = result.payload as ListProjectSessionsResultPayload | undefined;
      const normalizedPayload = payload ?? {
        cwd: project.cwd,
        label: project.label,
        sessions: []
      };

      patchWorkspace((current) => ({
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

      setProjectThreads(project.id, (threads) => mergeProjectThreads(threads, normalizedPayload.sessions));
      return normalizedPayload;
    } finally {
      setProjectLoadingId((current) => (current === project.id ? null : current));
    }
  }

  async function refreshAllProjectThreads(): Promise<void> {
    if (projectsRefreshing || workspaceState.projects.length === 0) {
      return;
    }

    setProjectsRefreshing(true);

    try {
      setError('');
      const latestThreadsByProject = new Map<string, ProjectThreadEntry[]>(
        Object.entries(projectThreadsById).map(([projectId, threads]) => [projectId, threads])
      );
      let nextActiveThreadId: string | null | undefined;
      let refreshErrorMessage = '';

      for (const project of workspaceState.projects) {
        if (!project.cliId) {
          continue;
        }

        try {
          const history = await refreshProjectThreads(project);
          const mergedThreads = mergeProjectThreads(latestThreadsByProject.get(project.id) ?? [], history.sessions);
          latestThreadsByProject.set(project.id, mergedThreads);

          if (project.id === workspaceState.activeProjectId) {
            const activeCandidate =
              mergedThreads.find((thread) => thread.id === workspaceState.activeThreadId) ??
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
        patchWorkspace((current) =>
          current.activeThreadId === nextActiveThreadId ? current : { ...current, activeThreadId: nextActiveThreadId }
        );
      }

      if (refreshErrorMessage) {
        setError(refreshErrorMessage);
      }
    } finally {
      setProjectsRefreshing(false);
    }
  }

  async function activateThread(project: ProjectEntry, thread: ProjectThreadEntry): Promise<void> {
    try {
      setError('');
      requestedThreadKeyRef.current = `${project.cliId}:${thread.threadKey}:${thread.sessionId ?? 'draft'}`;
      if (thread.sessionId === null) {
        setSnapshot(createEmptySnapshot());
        setOlderMessages([]);
        setHasOlderMessages(false);
      }
      patchWorkspace((current) => ({
        ...current,
        activeCliId: project.cliId,
        activeProjectId: project.id,
        activeThreadId: thread.id
      }));
      if (isMobileViewport()) {
        patchWorkspace((current) => (current.sidebarCollapsed ? current : { ...current, sidebarCollapsed: true }));
      }

      await sendCommand(
        'select-thread',
        {
          cwd: project.cwd,
          threadKey: thread.threadKey,
          sessionId: thread.sessionId
        },
        project.cliId
      );
      setMobilePane('chat');
    } catch (activateError) {
      requestedThreadKeyRef.current = null;
      setError(activateError instanceof Error ? activateError.message : '切换 thread 失败');
    }
  }

  async function handleAddProject(): Promise<void> {
    try {
      setError('');
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

      patchWorkspace((current) => {
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
      const nextThreads = mergeProjectThreads(projectThreadsById[selectedProject.id] ?? [], history.sessions);
      const resolvedThreads = nextThreads.length > 0 ? nextThreads : [draftThread];
      const nextThread = resolvedThreads.find((thread) => thread.sessionId === history.sessions[0]?.sessionId) ?? resolvedThreads[0];
      setProjectThreads(selectedProject.id, () => resolvedThreads);

      if (nextThread) {
        await activateThread(selectedProject, nextThread);
      }
    } catch (addProjectError) {
      setError(addProjectError instanceof Error ? addProjectError.message : '添加项目失败');
    }
  }

  function handleCreateThread(projectId: string): void {
    const nextProject = workspaceState.projects.find((project) => project.id === projectId) ?? null;
    const nextThread = createDraftThread();
    setProjectThreads(projectId, (threads) => sortThreads([nextThread, ...threads]));
    patchWorkspace((current) => ({
      ...current,
      activeCliId: nextProject?.cliId ?? current.activeCliId,
      activeProjectId: projectId,
      activeThreadId: nextThread.id
    }));

    if (nextProject) {
      void activateThread(nextProject, nextThread);
    }
  }

  function handleSelectCli(nextCliId: string | null): void {
    patchWorkspace((current) => ({
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

  function handleSelectProject(project: ProjectEntry, firstThreadId: string | null): void {
    patchWorkspace((current) => ({
      ...current,
      activeCliId: project.cliId,
      activeProjectId: project.id,
      activeThreadId: firstThreadId ?? current.activeThreadId
    }));
    if (isMobileViewport()) {
      patchWorkspace((current) => (current.sidebarCollapsed ? current : { ...current, sidebarCollapsed: true }));
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const content = prompt.trim();
    if (!content) {
      setError('请输入消息');
      return;
    }
    if (!activeProject || !activeThread) {
      setError('请先在侧边栏选择一个 project / thread');
      return;
    }

    try {
      setError('');
      await sendCommand('send-message', { content });
      setPrompt('');
      setMobilePane('chat');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function handleStop(): Promise<void> {
    try {
      setError('');
      await sendCommand('stop-message', {});
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : '结束失败');
    }
  }

  async function handleLoadOlderMessages(beforeMessageId: string | undefined): Promise<boolean> {
    try {
      setError('');
      setOlderMessagesLoading(true);

      const result = await sendCommand('get-older-messages', {
        beforeMessageId,
        maxMessages: 40
      });
      const payload = result.payload as GetOlderMessagesResultPayload | undefined;

      if ((payload?.threadKey ?? null) !== snapshot.threadKey) {
        return false;
      }

      setOlderMessages((current) => mergeChronologicalMessages(payload?.messages ?? [], current));
      setHasOlderMessages(Boolean(payload?.hasOlderMessages));
      return Boolean(payload?.messages?.length);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载更早消息失败');
      return false;
    } finally {
      setOlderMessagesLoading(false);
    }
  }

  return (
    <div className="h-dvh overflow-hidden bg-white text-zinc-900 lg:flex lg:bg-zinc-100">
      <Sidebar
        activeCliId={workspaceState.activeCliId}
        activeProjectId={workspaceState.activeProjectId}
        activeThreadId={workspaceState.activeThreadId}
        clis={clis}
        collapsed={workspaceState.sidebarCollapsed}
        projectThreadsById={projectThreadsById}
        projects={workspaceState.projects}
        projectsRefreshing={projectsRefreshing}
        toggleTop={sidebarToggleTop}
        onActivateThread={(project, thread) => {
          void activateThread(project, thread);
        }}
        onAddProject={() => {
          void handleAddProject();
        }}
        onCollapsedChange={(collapsed) => {
          patchWorkspace((current) => ({ ...current, sidebarCollapsed: collapsed }));
        }}
        onCreateThread={handleCreateThread}
        onRefreshAllProjects={() => {
          void refreshAllProjectThreads();
        }}
        onSelectCli={handleSelectCli}
        onSelectProject={handleSelectProject}
        onToggleTopChange={setSidebarToggleTop}
        onToggleTopCommit={commitSidebarToggleTop}
      />
      <WorkspaceScreen
        chatPaneProps={{
          connected,
          hasOlderMessages,
          messages: visibleMessages,
          olderMessagesLoading,
          visible: mobilePane === 'chat',
          onLoadOlderMessages: handleLoadOlderMessages
        }}
        composerProps={{
          busy,
          canSend,
          canStop,
          cliBadge,
          conversationBadge,
          footerErrorText,
          placeholder: composerPlaceholder,
          prompt,
          socketBadge,
          onPromptChange: setPrompt,
          onStop: () => {
            void handleStop();
          },
          onSubmit: handleSubmit
        }}
        headerSummary={headerSummary}
        mobilePane={mobilePane}
        terminalPaneProps={{
          hostRef: terminal.terminalHostRef,
          viewportRef: terminal.terminalViewportRef,
          visible: mobilePane === 'terminal',
          onJumpToEdge: terminal.jumpToEdge
        }}
        onMobilePaneChange={setMobilePane}
      />
    </div>
  );
}
