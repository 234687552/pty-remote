import { useEffect, useMemo, useRef, useState } from 'react';

import type { ManagedPtyLifecycle, ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';
import { PROVIDER_LABELS, type CliDescriptor, type ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import {
  getProjectProviderKey,
  type ProjectConversationEntry,
  type ProjectEntry
} from '@/lib/workspace.ts';

interface SidebarProps {
  activeCliId: string | null;
  activeProjectId: string | null;
  activeProviderId: ProviderId | null;
  activeConversationId: string | null;
  clis: CliDescriptor[];
  collapsed: boolean;
  mobileOpen: boolean;
  projectConversationsByKey: Record<string, ProjectConversationEntry[]>;
  projects: ProjectEntry[];
  onAddProject: (input: { cwd: string; providerId: ProviderId }) => Promise<void>;
  onActivateConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => void;
  onCreateConversation: (project: ProjectEntry, providerId: ProviderId) => Promise<void>;
  onDeleteConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => Promise<void>;
  onRefreshConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => Promise<void>;
  onImportConversationFromSession: (
    providerId: ProviderId,
    session: ProjectSessionSummary
  ) => Promise<void>;
  onListManagedPtyHandles: () => Promise<{
    providerId: ProviderId;
    cliId: string;
    cliLabel: string;
    runtimeBackend: string;
    connected: boolean;
    conversationKey: string;
    sessionId: string | null;
    cwd: string;
    label: string;
    lifecycle: ManagedPtyLifecycle;
    hasPty: boolean;
    lastActivityAt: number | null;
  }[]>;
  onPickProjectDirectory: (providerId: ProviderId) => Promise<string | null>;
  onListRecentProjectSessions: (providerId: ProviderId, maxSessions?: number) => Promise<ProjectSessionSummary[]>;
  onMobileOpenChange: (open: boolean) => void;
  onSelectCli: (cliId: string | null) => void;
  onSelectProject: (project: ProjectEntry) => void;
}

const SWIPE_ACTION_WIDTH = 96;
const DELETE_LONG_PRESS_DELAY_MS = 420;
const LONG_PRESS_MOVE_THRESHOLD = 10;
const RECENT_HISTORY_TOP_K = 12;
const ALL_PROVIDERS: ProviderId[] = ['claude', 'codex'];

type HistoryDialogTab = 'recent' | 'pty';

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const diffMs = timestamp - Date.now();
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  if (Math.abs(diffMinutes) < 1) {
    return '刚刚';
  }
  if (Math.abs(diffMinutes) < 60) {
    return `${Math.abs(diffMinutes)} 分钟前`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return `${Math.abs(diffHours)} 小时前`;
  }

  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 7) {
    return `${Math.abs(diffDays)} 天前`;
  }

  const diffWeeks = Math.round(diffDays / 7);
  if (Math.abs(diffWeeks) < 5) {
    return `${Math.abs(diffWeeks)} 周前`;
  }

  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return `${Math.abs(diffMonths)} 个月前`;
  }

  const diffYears = Math.round(diffDays / 365);
  return `${Math.abs(diffYears)} 年前`;
}

function managedPtyLifecycleClass(lifecycle: ManagedPtyLifecycle): string {
  if (lifecycle === 'attached') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (lifecycle === 'detached') {
    return 'border-amber-200 bg-amber-50 text-amber-700';
  }
  if (lifecycle === 'error') {
    return 'border-red-200 bg-red-50 text-red-700';
  }
  return 'border-zinc-200 bg-zinc-100 text-zinc-600';
}

function providerBadgeClass(providerId: ProviderId): string {
  return providerId === 'claude'
    ? 'bg-orange-100 text-orange-700 border-orange-200'
    : 'bg-emerald-100 text-emerald-700 border-emerald-200';
}

function sortConversationEntries(entries: ProjectConversationEntry[]): ProjectConversationEntry[] {
  return [...entries];
}

function sortSessions(entries: ProjectSessionSummary[]): ProjectSessionSummary[] {
  return [...entries].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
      `${right.providerId}:${right.sessionId}`.localeCompare(`${left.providerId}:${left.sessionId}`)
  );
}

export function Sidebar({
  activeCliId,
  activeProjectId,
  activeProviderId,
  activeConversationId,
  clis,
  collapsed,
  mobileOpen,
  projectConversationsByKey,
  projects,
  onAddProject,
  onActivateConversation,
  onCreateConversation,
  onDeleteConversation,
  onRefreshConversation,
  onImportConversationFromSession,
  onListManagedPtyHandles,
  onPickProjectDirectory,
  onListRecentProjectSessions,
  onMobileOpenChange,
  onSelectCli,
  onSelectProject
}: SidebarProps) {
  const [createConversationDialogProject, setCreateConversationDialogProject] = useState<ProjectEntry | null>(null);
  const [createConversationDialogProviderId, setCreateConversationDialogProviderId] = useState<ProviderId>('claude');
  const [createConversationDialogSubmitting, setCreateConversationDialogSubmitting] = useState(false);
  const [createConversationDialogError, setCreateConversationDialogError] = useState('');
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [createProjectCwd, setCreateProjectCwd] = useState('');
  const [createProjectProviderId, setCreateProjectProviderId] = useState<ProviderId>('claude');
  const [createProjectSubmitting, setCreateProjectSubmitting] = useState(false);
  const [createProjectPickingDirectory, setCreateProjectPickingDirectory] = useState(false);
  const [createProjectError, setCreateProjectError] = useState('');
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyImportingSessionKey, setHistoryImportingSessionKey] = useState<string | null>(null);
  const [historySessions, setHistorySessions] = useState<ProjectSessionSummary[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyDialogTab, setHistoryDialogTab] = useState<HistoryDialogTab>('recent');
  const [ptyHandlesLoading, setPtyHandlesLoading] = useState(false);
  const [ptyHandlesError, setPtyHandlesError] = useState('');
  const [ptyHandles, setPtyHandles] = useState<
    {
      providerId: ProviderId;
      cliId: string;
      cliLabel: string;
      runtimeBackend: string;
      connected: boolean;
      conversationKey: string;
      sessionId: string | null;
      cwd: string;
      label: string;
      lifecycle: ManagedPtyLifecycle;
      hasPty: boolean;
      lastActivityAt: number | null;
    }[]
  >([]);
  const [deleteConversationPendingId, setDeleteConversationPendingId] = useState<string | null>(null);
  const [refreshConversationPendingId, setRefreshConversationPendingId] = useState<string | null>(null);
  const [swipeOffsets, setSwipeOffsets] = useState<Record<string, number>>({});
  const [openSwipeRowKey, setOpenSwipeRowKey] = useState<string | null>(null);
  const longPressRef = useRef<{
    rowKey: string;
    pointerId: number;
    startX: number;
    startY: number;
    timerId: number | null;
    triggered: boolean;
  } | null>(null);
  const suppressClickRowKeyRef = useRef<string | null>(null);
  const connectedProviderIds = useMemo(
    () =>
      ALL_PROVIDERS.filter((providerId) =>
        clis.some((cli) => cli.connected && cli.supportedProviders.includes(providerId))
      ),
    [clis]
  );

  const createProviderId = useMemo(() => {
    if (activeProviderId && connectedProviderIds.includes(activeProviderId)) {
      return activeProviderId;
    }
    return connectedProviderIds[0] ?? null;
  }, [activeProviderId, connectedProviderIds]);

  const existingSessionKeys = useMemo(
    () =>
      new Set(
        Object.values(projectConversationsByKey)
          .flat()
          .filter((conversation) => Boolean(conversation.sessionId))
          .map((conversation) => `${conversation.providerId}:${conversation.sessionId}`)
      ),
    [projectConversationsByKey]
  );

  const ptyHandleEntries = useMemo(
    () =>
      [...ptyHandles].sort((left, right) => {
        if (left.hasPty !== right.hasPty) {
          return left.hasPty ? -1 : 1;
        }
        const leftLastActivityAt = left.lastActivityAt ?? 0;
        const rightLastActivityAt = right.lastActivityAt ?? 0;
        if (leftLastActivityAt !== rightLastActivityAt) {
          return rightLastActivityAt - leftLastActivityAt;
        }
        if (left.providerId !== right.providerId) {
          return left.providerId.localeCompare(right.providerId);
        }
        return left.cliLabel.localeCompare(right.cliLabel) || left.conversationKey.localeCompare(right.conversationKey);
      }),
    [ptyHandles]
  );

  useEffect(() => {
    if (!historyDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !historyLoading && !historyImportingSessionKey) {
        setHistoryDialogOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [historyDialogOpen, historyImportingSessionKey, historyLoading]);

  useEffect(() => {
    if (!createConversationDialogProject) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !createConversationDialogSubmitting) {
        closeCreateConversationDialog();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [createConversationDialogProject, createConversationDialogSubmitting]);

  useEffect(() => {
    if (!createProjectDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !createProjectSubmitting && !createProjectPickingDirectory) {
        closeCreateProjectDialog();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [createProjectDialogOpen, createProjectPickingDirectory, createProjectSubmitting]);

  useEffect(
    () => () => {
      const current = longPressRef.current;
      if (current?.timerId) {
        window.clearTimeout(current.timerId);
      }
      longPressRef.current = null;
    },
    []
  );

  function clampSwipeOffset(offset: number): number {
    return Math.max(0, Math.min(SWIPE_ACTION_WIDTH, Math.round(offset)));
  }

  function setSwipeOffset(rowKey: string, nextOffset: number): void {
    const normalizedOffset = clampSwipeOffset(nextOffset);
    setSwipeOffsets((current) => {
      const currentOffset = current[rowKey] ?? 0;
      if (currentOffset === normalizedOffset) {
        return current;
      }
      if (normalizedOffset === 0) {
        if (!(rowKey in current)) {
          return current;
        }
        const { [rowKey]: _removed, ...rest } = current;
        return rest;
      }
      return {
        ...current,
        [rowKey]: normalizedOffset
      };
    });
  }

  function closeSwipeRow(rowKey: string): void {
    setSwipeOffset(rowKey, 0);
    setOpenSwipeRowKey((current) => (current === rowKey ? null : current));
  }

  function closeAllSwipeRows(): void {
    setOpenSwipeRowKey(null);
    setSwipeOffsets({});
  }

  function openSwipeRow(rowKey: string): void {
    setSwipeOffsets((current) => {
      const next: Record<string, number> = {};
      next[rowKey] = SWIPE_ACTION_WIDTH;
      if (current[rowKey] === SWIPE_ACTION_WIDTH && Object.keys(current).length === 1) {
        return current;
      }
      return next;
    });
    setOpenSwipeRowKey(rowKey);
  }

  function clearLongPress(rowKey?: string, pointerId?: number): { triggered: boolean } {
    const current = longPressRef.current;
    if (!current) {
      return { triggered: false };
    }

    if (rowKey !== undefined && (current.rowKey !== rowKey || (pointerId !== undefined && current.pointerId !== pointerId))) {
      return { triggered: false };
    }

    if (current.timerId !== null) {
      window.clearTimeout(current.timerId);
    }

    const triggered = current.triggered;
    longPressRef.current = null;
    return { triggered };
  }

  function handleLongPressPointerDown(rowKey: string, event: React.PointerEvent<HTMLElement>): void {
    if (event.pointerType === 'mouse') {
      return;
    }

    clearLongPress();
    if (openSwipeRowKey && openSwipeRowKey !== rowKey) {
      closeSwipeRow(openSwipeRowKey);
    }

    const pointerId = event.pointerId;
    const timerId = window.setTimeout(() => {
      const current = longPressRef.current;
      if (!current || current.rowKey !== rowKey || current.pointerId !== pointerId) {
        return;
      }
      current.triggered = true;
      current.timerId = null;
      openSwipeRow(rowKey);
    }, DELETE_LONG_PRESS_DELAY_MS);

    longPressRef.current = {
      rowKey,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timerId,
      triggered: false
    };
  }

  function handleLongPressPointerMove(rowKey: string, event: React.PointerEvent<HTMLElement>): void {
    if (event.pointerType === 'mouse') {
      return;
    }

    const current = longPressRef.current;
    if (!current || current.rowKey !== rowKey || current.pointerId !== event.pointerId || current.triggered) {
      return;
    }

    const movedX = Math.abs(event.clientX - current.startX);
    const movedY = Math.abs(event.clientY - current.startY);
    if (movedX < LONG_PRESS_MOVE_THRESHOLD && movedY < LONG_PRESS_MOVE_THRESHOLD) {
      return;
    }

    clearLongPress(rowKey, event.pointerId);
  }

  function finishLongPress(rowKey: string, pointerId: number): boolean {
    const { triggered } = clearLongPress(rowKey, pointerId);
    if (triggered) {
      suppressClickRowKeyRef.current = rowKey;
      window.setTimeout(() => {
        if (suppressClickRowKeyRef.current === rowKey) {
          suppressClickRowKeyRef.current = null;
        }
      }, 0);
    }
    return triggered;
  }

  function handleLongPressPointerUp(rowKey: string, event: React.PointerEvent<HTMLElement>): void {
    if (event.pointerType === 'mouse') {
      return;
    }

    const triggered = finishLongPress(rowKey, event.pointerId);
    if (triggered) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleLongPressPointerCancel(rowKey: string, event: React.PointerEvent<HTMLElement>): void {
    if (event.pointerType === 'mouse') {
      return;
    }

    clearLongPress(rowKey, event.pointerId);
  }

  function handleLongPressMouseDown(rowKey: string, event: React.MouseEvent<HTMLElement>): void {
    if (event.button !== 0) {
      return;
    }

    clearLongPress();
    if (openSwipeRowKey && openSwipeRowKey !== rowKey) {
      closeSwipeRow(openSwipeRowKey);
    }

    const pointerId = -1;
    const timerId = window.setTimeout(() => {
      const current = longPressRef.current;
      if (!current || current.rowKey !== rowKey || current.pointerId !== pointerId) {
        return;
      }
      current.triggered = true;
      current.timerId = null;
      openSwipeRow(rowKey);
    }, DELETE_LONG_PRESS_DELAY_MS);

    longPressRef.current = {
      rowKey,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timerId,
      triggered: false
    };
  }

  function handleLongPressMouseMove(rowKey: string, event: React.MouseEvent<HTMLElement>): void {
    const current = longPressRef.current;
    if (!current || current.rowKey !== rowKey || current.pointerId !== -1 || current.triggered) {
      return;
    }

    if ((event.buttons & 1) === 0) {
      clearLongPress(rowKey, -1);
      return;
    }

    const movedX = Math.abs(event.clientX - current.startX);
    const movedY = Math.abs(event.clientY - current.startY);
    if (movedX < LONG_PRESS_MOVE_THRESHOLD && movedY < LONG_PRESS_MOVE_THRESHOLD) {
      return;
    }

    clearLongPress(rowKey, -1);
  }

  function handleLongPressMouseUp(rowKey: string, event: React.MouseEvent<HTMLElement>): void {
    if (event.button !== 0) {
      return;
    }

    const triggered = finishLongPress(rowKey, -1);
    if (triggered) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleLongPressMouseLeave(rowKey: string): void {
    clearLongPress(rowKey, -1);
  }

  function closeMobileSidebar(): void {
    if (mobileOpen) {
      onMobileOpenChange(false);
    }
  }

  function shouldBlockRowAction(rowKey: string): boolean {
    if (suppressClickRowKeyRef.current === rowKey) {
      suppressClickRowKeyRef.current = null;
      return true;
    }
    const currentOffset = swipeOffsets[rowKey] ?? 0;
    if (currentOffset > 0) {
      closeSwipeRow(rowKey);
      return true;
    }
    return false;
  }

  function getProjectDefaultConversation(project: ProjectEntry): ProjectConversationEntry | null {
    const providerOrder = activeProviderId
      ? [activeProviderId, ...ALL_PROVIDERS.filter((providerId) => providerId !== activeProviderId)]
      : ALL_PROVIDERS;

    for (const providerId of providerOrder) {
      const conversations = sortConversationEntries(projectConversationsByKey[getProjectProviderKey(project.id, providerId)] ?? []);
      if (conversations.length > 0) {
        return conversations[0] ?? null;
      }
    }

    return null;
  }

  function handleProjectSelect(project: ProjectEntry): void {
    closeAllSwipeRows();

    const nextConversation = getProjectDefaultConversation(project);
    if (nextConversation) {
      onActivateConversation(project, nextConversation.providerId, nextConversation);
    } else {
      onSelectProject(project);
    }

    closeMobileSidebar();
  }

  function openCreateConversationDialog(project: ProjectEntry): void {
    if (connectedProviderIds.length === 0 || createConversationDialogSubmitting) {
      return;
    }

    closeAllSwipeRows();
    setCreateConversationDialogError('');
    setCreateConversationDialogProviderId(
      createProviderId && connectedProviderIds.includes(createProviderId) ? createProviderId : connectedProviderIds[0] ?? 'claude'
    );
    setCreateConversationDialogProject(project);
  }

  function closeCreateConversationDialog(): void {
    if (createConversationDialogSubmitting) {
      return;
    }

    setCreateConversationDialogProject(null);
    setCreateConversationDialogError('');
  }

  async function handleCreateConversationDialogSubmit(): Promise<void> {
    if (!createConversationDialogProject || createConversationDialogSubmitting) {
      return;
    }

    setCreateConversationDialogSubmitting(true);
    setCreateConversationDialogError('');
    try {
      await onCreateConversation(createConversationDialogProject, createConversationDialogProviderId);
      setCreateConversationDialogProject(null);
      closeMobileSidebar();
    } catch (error) {
      setCreateConversationDialogError(error instanceof Error ? error.message : '创建会话失败');
    } finally {
      setCreateConversationDialogSubmitting(false);
    }
  }

  function openCreateProjectDialog(): void {
    if (connectedProviderIds.length === 0 || createProjectSubmitting || createProjectPickingDirectory) {
      return;
    }

    closeAllSwipeRows();
    setCreateProjectError('');
    setCreateProjectCwd('');
    setCreateProjectProviderId(
      createProviderId && connectedProviderIds.includes(createProviderId) ? createProviderId : connectedProviderIds[0] ?? 'claude'
    );
    setCreateProjectDialogOpen(true);
  }

  function closeCreateProjectDialog(): void {
    if (createProjectSubmitting || createProjectPickingDirectory) {
      return;
    }

    setCreateProjectDialogOpen(false);
    setCreateProjectError('');
  }

  async function handlePickProjectDirectory(): Promise<void> {
    if (createProjectPickingDirectory || createProjectSubmitting) {
      return;
    }

    setCreateProjectError('');
    setCreateProjectPickingDirectory(true);
    try {
      const cwd = await onPickProjectDirectory(createProjectProviderId);
      if (cwd) {
        setCreateProjectCwd(cwd);
      }
    } catch (error) {
      setCreateProjectError(error instanceof Error ? error.message : '选择目录失败');
    } finally {
      setCreateProjectPickingDirectory(false);
    }
  }

  async function handleCreateProjectSubmit(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (createProjectSubmitting) {
      return;
    }

    const normalizedCwd = createProjectCwd.trim();
    if (!normalizedCwd) {
      setCreateProjectError('目录路径不能为空');
      return;
    }

    setCreateProjectSubmitting(true);
    setCreateProjectError('');
    try {
      await onAddProject({
        cwd: normalizedCwd,
        providerId: createProjectProviderId
      });
      setCreateProjectDialogOpen(false);
      setCreateProjectCwd('');
      closeMobileSidebar();
    } catch (error) {
      setCreateProjectError(error instanceof Error ? error.message : '新建项目失败');
    } finally {
      setCreateProjectSubmitting(false);
    }
  }

  async function openHistoryDialog(): Promise<void> {
    if (historyLoading) {
      return;
    }

    closeAllSwipeRows();
    setHistoryDialogOpen(true);
    setHistoryDialogTab('recent');
    setHistorySessions([]);
    setHistoryError('');
    setPtyHandles([]);
    setPtyHandlesError('');
    void refreshManagedPtyHandles();

    if (connectedProviderIds.length === 0) {
      setHistoryError('当前没有可用的 Claude/Codex CLI');
      return;
    }

    setHistoryLoading(true);
    try {
      const results = await Promise.allSettled(
        connectedProviderIds.map((providerId) =>
          onListRecentProjectSessions(providerId, RECENT_HISTORY_TOP_K).then((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerId
            }))
          )
        )
      );

      const merged: ProjectSessionSummary[] = [];
      let firstError = '';
      for (const result of results) {
        if (result.status === 'fulfilled') {
          merged.push(...result.value);
          continue;
        }

        if (!firstError) {
          firstError = result.reason instanceof Error ? result.reason.message : '加载历史会话失败';
        }
      }

      const deduped = new Map<string, ProjectSessionSummary>();
      for (const session of sortSessions(merged)) {
        const key = `${session.providerId}:${session.sessionId}`;
        if (!deduped.has(key)) {
          deduped.set(key, session);
        }
      }

      const resolvedSessions = sortSessions([...deduped.values()]);
      setHistorySessions(resolvedSessions);
      if (resolvedSessions.length === 0 && firstError) {
        setHistoryError(firstError);
      }
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '加载历史会话失败');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function refreshManagedPtyHandles(): Promise<void> {
    if (ptyHandlesLoading) {
      return;
    }
    setPtyHandlesLoading(true);
    setPtyHandlesError('');
    try {
      const entries = await onListManagedPtyHandles();
      setPtyHandles(entries);
    } catch (error) {
      setPtyHandles([]);
      setPtyHandlesError(error instanceof Error ? error.message : '加载 PTY 列表失败');
    } finally {
      setPtyHandlesLoading(false);
    }
  }

  function closeHistoryDialog(): void {
    if (historyLoading || historyImportingSessionKey) {
      return;
    }

    setHistoryDialogOpen(false);
  }

  async function handleImportHistorySession(session: ProjectSessionSummary): Promise<void> {
    if (historyImportingSessionKey) {
      return;
    }

    const sessionKey = `${session.providerId}:${session.sessionId}`;
    setHistoryImportingSessionKey(sessionKey);
    setHistoryError('');

    try {
      await onImportConversationFromSession(session.providerId, session);
      setHistoryDialogOpen(false);
      closeMobileSidebar();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '导入历史会话失败');
    } finally {
      setHistoryImportingSessionKey(null);
    }
  }

  const sidebarContent = (
    <>
      <div className="border-b border-zinc-200/80 bg-white/90 px-3 py-2 backdrop-blur-sm">
        <div className="flex justify-center pb-2 lg:hidden">
          <div className="h-1 w-10 rounded-full bg-zinc-300" aria-hidden="true" />
        </div>
        <div className="text-xs font-medium text-zinc-500">会话目录</div>
      </div>

      <div className="flex flex-1 flex-col-reverse gap-2.5 overflow-auto p-2.5 lg:block lg:space-y-2.5">
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
            暂无目录。
          </div>
        ) : (
          projects.map((project) => {
            const isActiveProject = project.id === activeProjectId;
            const conversations = sortConversationEntries(
              ALL_PROVIDERS.flatMap(
                (providerId) => projectConversationsByKey[getProjectProviderKey(project.id, providerId)] ?? []
              )
            );

            return (
              <section
                key={project.id}
                className={[
                  'rounded-2xl border px-2.5 py-2.5 transition',
                  isActiveProject
                    ? 'border-zinc-300 bg-zinc-100/90 text-zinc-900 shadow-[0_10px_24px_rgba(24,24,27,0.08)]'
                    : 'border-zinc-200 bg-transparent'
                ].join(' ')}
              >
                <div className="rounded-xl">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => handleProjectSelect(project)}
                      className={[
                        'min-w-0 flex-1 rounded-xl px-1 py-1 text-left transition',
                        isActiveProject ? 'hover:bg-white/70' : 'hover:bg-zinc-100'
                      ].join(' ')}
                    >
                      <div className="truncate text-[13px] font-semibold">{project.label}</div>
                      <div
                        className={[
                          'mt-0.5 line-clamp-1 text-[11px]',
                          isActiveProject ? 'text-zinc-600' : 'text-zinc-500'
                        ].join(' ')}
                      >
                        {project.cwd}
                      </div>
                    </button>
                    <button
                      type="button"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onMouseDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openCreateConversationDialog(project);
                      }}
                      disabled={connectedProviderIds.length === 0 || createConversationDialogSubmitting}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-300 bg-white/80 text-zinc-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`在 ${project.label} 新建会话`}
                      title={`在 ${project.label} 新建会话`}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                        <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="mt-2 flex flex-col-reverse gap-1 lg:block lg:space-y-1">
                  {conversations.length === 0 ? (
                    <div
                      className={[
                        'rounded-xl border px-2.5 py-2 text-[11px]',
                        isActiveProject ? 'border-zinc-300 bg-white/70 text-zinc-600' : 'border-zinc-200 text-zinc-500'
                      ].join(' ')}
                    >
                      这个目录还没有会话
                    </div>
                  ) : (
                    conversations.map((conversation) => {
                      const conversationSwipeRowKey = `conversation:${conversation.id}`;
                      const conversationSwipeOffset = swipeOffsets[conversationSwipeRowKey] ?? 0;
                      const conversationDeleteVisible =
                        conversationSwipeOffset > 0 ||
                        deleteConversationPendingId === conversation.id ||
                        refreshConversationPendingId === conversation.id;
                      const isActiveConversation =
                        isActiveProject &&
                        conversation.providerId === activeProviderId &&
                        conversation.id === activeConversationId;
                      const conversationActionPending =
                        deleteConversationPendingId === conversation.id || refreshConversationPendingId === conversation.id;
                      return (
                        <div
                          key={conversation.id}
                          className="relative overflow-hidden rounded-xl"
                        >
                          <div
                            className={[
                              'absolute inset-y-0 right-0 flex items-center gap-2 pr-1.5 transition-opacity',
                              conversationDeleteVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                            ].join(' ')}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                closeAllSwipeRows();
                                setRefreshConversationPendingId(conversation.id);
                                void onRefreshConversation(project, conversation.providerId, conversation).finally(() => {
                                  setRefreshConversationPendingId((current) =>
                                    current === conversation.id ? null : current
                                  );
                                });
                              }}
                              disabled={conversationActionPending}
                              aria-label="重刷会话"
                              title={refreshConversationPendingId === conversation.id ? '重刷中' : '重刷会话'}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500 text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <svg
                                viewBox="0 0 20 20"
                                fill="none"
                                aria-hidden="true"
                                className={`h-4 w-4 ${refreshConversationPendingId === conversation.id ? 'animate-spin' : ''}`}
                              >
                                <path
                                  d="M16 10a6 6 0 1 1-1.73-4.22"
                                  stroke="currentColor"
                                  strokeWidth="1.7"
                                  strokeLinecap="round"
                                />
                                <path
                                  d="M16 4.8v3.8h-3.8"
                                  stroke="currentColor"
                                  strokeWidth="1.7"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                closeAllSwipeRows();
                                setDeleteConversationPendingId(conversation.id);
                                void onDeleteConversation(project, conversation.providerId, conversation).finally(() => {
                                  setDeleteConversationPendingId((current) => (current === conversation.id ? null : current));
                                });
                              }}
                              disabled={conversationActionPending}
                              aria-label="删除会话"
                              title={deleteConversationPendingId === conversation.id ? '删除中' : '删除会话'}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                                <path
                                  d="M5.8 6.3h8.4M8 6.3V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.3m-5.7 0 0.55 8.1a1 1 0 0 0 1 .94h4.24a1 1 0 0 0 1-.94l0.55-8.1"
                                  stroke="currentColor"
                                  strokeWidth="1.7"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                                <path d="M8.8 9.1v4.2M11.2 9.1v4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                          <div
                            className="relative transition-transform duration-150"
                            style={{
                              transform: `translateX(-${conversationSwipeOffset}px)`,
                              touchAction: 'pan-y'
                            }}
                          >
                            <button
                              type="button"
                              onPointerDown={(event) => handleLongPressPointerDown(conversationSwipeRowKey, event)}
                              onPointerMove={(event) => handleLongPressPointerMove(conversationSwipeRowKey, event)}
                              onPointerUp={(event) => handleLongPressPointerUp(conversationSwipeRowKey, event)}
                              onPointerCancel={(event) => handleLongPressPointerCancel(conversationSwipeRowKey, event)}
                              onPointerLeave={(event) => handleLongPressPointerCancel(conversationSwipeRowKey, event)}
                              onMouseDown={(event) => handleLongPressMouseDown(conversationSwipeRowKey, event)}
                              onMouseMove={(event) => handleLongPressMouseMove(conversationSwipeRowKey, event)}
                              onMouseUp={(event) => handleLongPressMouseUp(conversationSwipeRowKey, event)}
                              onMouseLeave={() => handleLongPressMouseLeave(conversationSwipeRowKey)}
                              onClick={() => {
                                if (shouldBlockRowAction(conversationSwipeRowKey)) {
                                  return;
                                }
                                onActivateConversation(project, conversation.providerId, conversation);
                                closeMobileSidebar();
                              }}
                              className={[
                                'block min-w-0 w-full rounded-xl border px-2.5 py-2 text-left transition',
                                isActiveConversation
                                  ? isActiveProject
                                    ? 'border-sky-200 bg-sky-50 text-zinc-950 shadow-sm'
                                    : 'border-sky-200 bg-sky-100 text-zinc-950'
                                  : isActiveProject
                                    ? 'border-transparent bg-transparent text-zinc-800 hover:bg-white/70'
                                    : 'border-transparent bg-transparent text-zinc-800 hover:bg-zinc-100'
                              ].join(' ')}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="min-w-0 truncate text-[13px] font-medium" title={conversation.title}>
                                  {conversation.title}
                                </span>
                                <span
                                  className="shrink-0 text-[10px] text-zinc-500"
                                  title={new Date(conversation.updatedAt).toLocaleString()}
                                >
                                  {formatRelativeTime(conversation.updatedAt)}
                                </span>
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span
                                  className={[
                                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                                    providerBadgeClass(conversation.providerId)
                                  ].join(' ')}
                                >
                                  {PROVIDER_LABELS[conversation.providerId]}
                                </span>
                                {conversation.draft ? <span className="text-[10px] text-zinc-400">草稿</span> : null}
                              </div>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>

      <div className="border-t border-zinc-200 bg-white/95 px-3 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <select
            value={activeCliId ?? ''}
            onChange={(event) => onSelectCli(event.target.value || null)}
            className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700"
          >
            <option value="">选择 CLI</option>
            {clis.map((entry) => (
              <option key={entry.cliId} value={entry.cliId}>
                {entry.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => openCreateProjectDialog()}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-300 text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={createProjectSubmitting ? '新建项目中' : '新建项目'}
            title={createProjectSubmitting ? '新建项目中' : '新建项目'}
            disabled={connectedProviderIds.length === 0 || createProjectSubmitting || createProjectPickingDirectory}
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
              className={['h-4 w-4', createProjectSubmitting || createProjectPickingDirectory ? 'animate-pulse' : ''].join(' ')}
            >
              <path
                d="M3.75 5.75a1 1 0 0 1 1-1h3l1.1 1.4a1 1 0 0 0 .79.39h5.61a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H4.75a1 1 0 0 1-1-1v-8.3Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M10 8.5v4M8 10.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => void openHistoryDialog()}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-300 text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={historyLoading ? '加载历史中' : '历史记录'}
            title={historyLoading ? '加载历史中' : '历史记录'}
            disabled={historyLoading}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={['h-4 w-4', historyLoading ? 'animate-spin' : ''].join(' ')}>
              <path
                d="M10 4.5a5.5 5.5 0 1 1-3.89 1.61"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M6.25 3.75v2.5h2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10 7.25V10l2 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <div
        className={[
          'fixed inset-0 z-40 transition-opacity duration-300 lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        ].join(' ')}
      >
        <button
          type="button"
          aria-label="关闭边栏蒙版"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onMobileOpenChange(false);
          }}
          className={[
            'absolute inset-0 bg-black/18 backdrop-blur-[1px] transition-opacity duration-300',
            mobileOpen ? 'opacity-100' : 'opacity-0'
          ].join(' ')}
        />

        <aside
          className={[
            'absolute inset-x-0 bottom-0 flex max-h-[min(82svh,44rem)] w-full flex-col rounded-t-[1.75rem] border-t border-zinc-200 bg-white shadow-[0_-18px_60px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out sm:mx-auto sm:max-w-[28rem] sm:rounded-[1.75rem] sm:border',
            mobileOpen ? 'translate-y-0' : 'translate-y-full'
          ].join(' ')}
          style={{
            paddingBottom: 'max(0px, env(safe-area-inset-bottom))'
          }}
        >
          {sidebarContent}
        </aside>
      </div>

      {!collapsed ? (
        <aside className="hidden h-full w-[22rem] shrink-0 flex-col border-r border-zinc-200 bg-white lg:flex">
          {sidebarContent}
        </aside>
      ) : null}

      {historyDialogOpen ? (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-sm" onClick={closeHistoryDialog}>
          <div
            className="flex h-full w-full items-end justify-center px-3 pb-3 sm:items-center sm:px-6 sm:pb-6"
            style={{
              paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
              paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
              paddingLeft: 'max(0.75rem, env(safe-area-inset-left))'
            }}
          >
            <div
              className="flex w-full max-w-2xl flex-col rounded-3xl border border-zinc-200 bg-white p-5 shadow-[0_24px_90px_rgba(15,23,42,0.22)]"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-zinc-900">
                    {historyDialogTab === 'recent' ? '最近历史会话' : '在途 PTY 管理'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeHistoryDialog}
                  disabled={historyLoading || Boolean(historyImportingSessionKey)}
                  className="rounded-xl border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  关闭
                </button>
              </div>

              <div className="mb-3 inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1">
                <button
                  type="button"
                  onClick={() => setHistoryDialogTab('recent')}
                  className={[
                    'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                    historyDialogTab === 'recent' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600 hover:text-zinc-900'
                  ].join(' ')}
                >
                  最近历史会话
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setHistoryDialogTab('pty');
                    if (!ptyHandlesLoading && ptyHandleEntries.length === 0) {
                      void refreshManagedPtyHandles();
                    }
                  }}
                  className={[
                    'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                    historyDialogTab === 'pty' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600 hover:text-zinc-900'
                  ].join(' ')}
                >
                  在途 PTY
                </button>
              </div>

              {historyDialogTab === 'recent' && historyError ? (
                <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{historyError}</div>
              ) : null}

              {historyDialogTab === 'recent' ? (
                <div className="max-h-[58vh] space-y-2 overflow-auto pr-1">
                  {historyLoading ? (
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-5 text-center text-sm text-zinc-500">加载历史会话中...</div>
                  ) : historySessions.length === 0 ? (
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-5 text-center text-sm text-zinc-500">
                      最近没有可导入的历史会话。
                    </div>
                  ) : (
                    historySessions.map((session) => {
                      const sessionKey = `${session.providerId}:${session.sessionId}`;
                      const exists = existingSessionKeys.has(sessionKey);
                      const importing = historyImportingSessionKey === sessionKey;
                      return (
                        <button
                          key={sessionKey}
                          type="button"
                          onClick={() => void handleImportHistorySession(session)}
                          disabled={Boolean(historyImportingSessionKey)}
                          className="block w-full rounded-xl border border-zinc-200 px-3 py-2 text-left transition hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate text-sm font-medium text-zinc-900">{session.title}</span>
                            <span className="shrink-0 text-[10px] text-zinc-500">{formatRelativeTime(session.updatedAt)}</span>
                          </div>
                          <div
                            className="mt-1 truncate text-[11px] text-zinc-500 [direction:rtl] text-right sm:[direction:ltr] sm:text-left"
                            title={session.cwd}
                          >
                            {session.cwd}
                          </div>
                          <div className="mt-1.5 flex items-center justify-between gap-2">
                            <span
                              className={[
                                'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                                providerBadgeClass(session.providerId)
                              ].join(' ')}
                            >
                              {PROVIDER_LABELS[session.providerId]}
                            </span>
                            <span className="text-[10px] font-medium text-zinc-500">
                              {importing ? '导入中...' : exists ? '已创建，点击切换' : '点击导入并创建'}
                            </span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              ) : (
                <div className="max-h-[58vh] space-y-2 overflow-auto pr-1">
                  {ptyHandlesError ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{ptyHandlesError}</div>
                  ) : ptyHandlesLoading ? (
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-5 text-center text-sm text-zinc-500">
                      加载 PTY 列表中...
                    </div>
                  ) : ptyHandleEntries.length === 0 ? (
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-5 text-center text-sm text-zinc-500">
                      当前没有可展示的 PTY 运行态。
                    </div>
                  ) : (
                    ptyHandleEntries.map((entry) => {
                      return (
                        <div
                          key={`${entry.providerId}:${entry.cliId}:${entry.conversationKey}:${entry.sessionId ?? 'draft'}`}
                          className="rounded-xl border border-zinc-200 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-zinc-900">{entry.label}</div>
                              <div className="truncate text-[10px] text-zinc-500">
                                {entry.cliLabel} ({entry.cliId})
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span
                                className={[
                                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                                  providerBadgeClass(entry.providerId)
                                ].join(' ')}
                              >
                                {PROVIDER_LABELS[entry.providerId]}
                              </span>
                              <span
                                className={[
                                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                                  managedPtyLifecycleClass(entry.lifecycle)
                                ].join(' ')}
                              >
                                {entry.lifecycle}
                              </span>
                              <span
                                className={[
                                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                                  entry.hasPty
                                    ? 'border-sky-200 bg-sky-50 text-sky-700'
                                    : 'border-zinc-200 bg-zinc-100 text-zinc-600'
                                ].join(' ')}
                              >
                                {entry.hasPty ? 'has-pty' : 'no-pty'}
                              </span>
                              <span
                                className={[
                                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                                  entry.connected
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'border-zinc-200 bg-zinc-100 text-zinc-600'
                                ].join(' ')}
                              >
                                {entry.connected ? 'online' : 'offline'}
                              </span>
                            </div>
                          </div>
                          <div className="mt-1.5 grid grid-cols-1 gap-1 text-[11px] text-zinc-600 sm:grid-cols-2">
                            <div className="truncate" title={entry.cwd}>
                              cwd: {entry.cwd}
                            </div>
                            <div className="truncate" title={entry.sessionId ?? '-'}>
                              session: {entry.sessionId ?? '-'}
                            </div>
                            <div className="truncate" title={entry.conversationKey}>
                              thread: {entry.conversationKey}
                            </div>
                            <div className="truncate" title={entry.runtimeBackend}>
                              backend: {entry.runtimeBackend}
                            </div>
                          </div>
                          <div className="mt-1 text-[10px] text-zinc-500">
                            lastActivity: {entry.lastActivityAt ? new Date(entry.lastActivityAt).toLocaleString() : '-'}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {createProjectDialogOpen ? (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-sm" onClick={closeCreateProjectDialog}>
          <div
            className="flex h-full w-full items-end justify-center px-3 pb-3 sm:items-center sm:px-6 sm:pb-6"
            style={{
              paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
              paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
              paddingLeft: 'max(0.75rem, env(safe-area-inset-left))'
            }}
          >
            <form
              className="flex w-full max-w-lg flex-col rounded-3xl border border-zinc-200 bg-white p-5 shadow-[0_24px_90px_rgba(15,23,42,0.22)]"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onSubmit={(event) => {
                void handleCreateProjectSubmit(event);
              }}
            >
              <div className="mb-1 text-base font-semibold text-zinc-900">新建项目</div>
              <div className="mb-4 text-sm text-zinc-500">填写项目目录，并选择用哪个 provider 创建会话。</div>

              <label className="mb-2 block text-xs font-medium tracking-wide text-zinc-500">目录</label>
              <div className="mb-4 flex items-center gap-2">
                <input
                  value={createProjectCwd}
                  onChange={(event) => setCreateProjectCwd(event.target.value)}
                  placeholder="/path/to/project"
                  autoFocus
                  className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
                />
                <button
                  type="button"
                  onClick={() => void handlePickProjectDirectory()}
                  disabled={createProjectSubmitting || createProjectPickingDirectory}
                  className="hidden shrink-0 rounded-xl border border-zinc-300 px-3 py-2.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
                >
                  {createProjectPickingDirectory ? '选择中...' : '选择目录'}
                </button>
              </div>

              <label className="mb-2 block text-xs font-medium tracking-wide text-zinc-500">Provider</label>
              <div className="mb-4 grid grid-cols-2 gap-2">
                {ALL_PROVIDERS.map((providerId) => {
                  const available = connectedProviderIds.includes(providerId);
                  const selected = createProjectProviderId === providerId;
                  return (
                    <button
                      key={providerId}
                      type="button"
                      onClick={() => setCreateProjectProviderId(providerId)}
                      disabled={!available || createProjectSubmitting || createProjectPickingDirectory}
                      className={[
                        'rounded-2xl border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45',
                        selected ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-white',
                        available ? '' : 'border-dashed'
                      ].join(' ')}
                    >
                      <div className="text-sm font-semibold">{PROVIDER_LABELS[providerId]}</div>
                      <div className={['mt-1 text-xs', selected ? 'text-zinc-300' : 'text-zinc-500'].join(' ')}>
                        {available ? '当前可用' : '当前无在线 CLI'}
                      </div>
                    </button>
                  );
                })}
              </div>

              {createProjectError ? (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {createProjectError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreateProjectDialog}
                  disabled={createProjectSubmitting || createProjectPickingDirectory}
                  className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={createProjectSubmitting || createProjectPickingDirectory || connectedProviderIds.length === 0}
                  className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createProjectSubmitting ? '确认中...' : '确认'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {createConversationDialogProject ? (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-sm" onClick={closeCreateConversationDialog}>
          <div
            className="flex h-full w-full items-end justify-center px-3 pb-3 sm:items-center sm:px-6 sm:pb-6"
            style={{
              paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
              paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
              paddingLeft: 'max(0.75rem, env(safe-area-inset-left))'
            }}
          >
            <div
              className="flex w-full max-w-lg flex-col rounded-3xl border border-zinc-200 bg-white p-5 shadow-[0_24px_90px_rgba(15,23,42,0.22)]"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <div className="mb-1 text-base font-semibold text-zinc-900">新建会话</div>
              <div className="mb-1 truncate text-sm font-medium text-zinc-700">{createConversationDialogProject.label}</div>
              <div className="mb-4 line-clamp-2 text-sm text-zinc-500">{createConversationDialogProject.cwd}</div>

              <label className="mb-2 block text-xs font-medium tracking-wide text-zinc-500">Provider</label>
              <div className="mb-4 grid grid-cols-2 gap-2">
                {ALL_PROVIDERS.map((providerId) => {
                  const available = connectedProviderIds.includes(providerId);
                  const selected = createConversationDialogProviderId === providerId;
                  return (
                    <button
                      key={providerId}
                      type="button"
                      onClick={() => setCreateConversationDialogProviderId(providerId)}
                      disabled={!available || createConversationDialogSubmitting}
                      className={[
                        'rounded-2xl border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45',
                        selected ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-white',
                        available ? '' : 'border-dashed'
                      ].join(' ')}
                    >
                      <div className="text-sm font-semibold">{PROVIDER_LABELS[providerId]}</div>
                      <div className={['mt-1 text-xs', selected ? 'text-zinc-300' : 'text-zinc-500'].join(' ')}>
                        {available ? '直接在当前项目下创建' : '当前无在线 CLI'}
                      </div>
                    </button>
                  );
                })}
              </div>

              {createConversationDialogError ? (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {createConversationDialogError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreateConversationDialog}
                  disabled={createConversationDialogSubmitting}
                  className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateConversationDialogSubmit()}
                  disabled={createConversationDialogSubmitting || connectedProviderIds.length === 0}
                  className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createConversationDialogSubmitting ? '创建中...' : '创建'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
