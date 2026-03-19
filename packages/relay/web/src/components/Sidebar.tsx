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
  onDeleteProject: (project: ProjectEntry) => Promise<void>;
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
  onReorderConversation: (
    project: ProjectEntry,
    providerId: ProviderId,
    sourceConversationId: string,
    targetConversationId: string
  ) => Promise<void>;
  onSelectCli: (cliId: string | null) => void;
  onSelectProject: (project: ProjectEntry) => void;
}

const SWIPE_DELETE_ACTION_WIDTH = 82;
const DELETE_LONG_PRESS_DELAY_MS = 420;
const LONG_PRESS_MOVE_THRESHOLD = 10;
const REORDER_DRAG_ACTIVATION_DISTANCE = 8;
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
  onDeleteProject,
  onImportConversationFromSession,
  onListManagedPtyHandles,
  onPickProjectDirectory,
  onListRecentProjectSessions,
  onMobileOpenChange,
  onReorderConversation,
  onSelectCli,
  onSelectProject
}: SidebarProps) {
  const [createConversationPending, setCreateConversationPending] = useState(false);
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
  const [deleteProjectPendingId, setDeleteProjectPendingId] = useState<string | null>(null);
  const [deleteConversationPendingId, setDeleteConversationPendingId] = useState<string | null>(null);
  const [swipeOffsets, setSwipeOffsets] = useState<Record<string, number>>({});
  const [openSwipeRowKey, setOpenSwipeRowKey] = useState<string | null>(null);
  const [draggingConversationId, setDraggingConversationId] = useState<string | null>(null);
  const [pressingReorderConversationId, setPressingReorderConversationId] = useState<string | null>(null);
  const longPressRef = useRef<{
    rowKey: string;
    pointerId: number;
    startX: number;
    startY: number;
    timerId: number | null;
    triggered: boolean;
  } | null>(null);
  const reorderPressRef = useRef<{
    projectId: string;
    providerId: ProviderId;
    conversationId: string;
    pointerId: number;
    startX: number;
    startY: number;
    triggered: boolean;
    lastTargetConversationId: string | null;
  } | null>(null);
  const conversationRowRef = useRef<Record<string, HTMLDivElement | null>>({});
  const suppressClickRowKeyRef = useRef<string | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

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

      const reorder = reorderPressRef.current;
      reorderPressRef.current = null;
    },
    []
  );

  function clampSwipeOffset(offset: number): number {
    return Math.max(0, Math.min(SWIPE_DELETE_ACTION_WIDTH, Math.round(offset)));
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
      next[rowKey] = SWIPE_DELETE_ACTION_WIDTH;
      if (current[rowKey] === SWIPE_DELETE_ACTION_WIDTH && Object.keys(current).length === 1) {
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

  function setConversationRowElement(conversationId: string, element: HTMLDivElement | null): void {
    if (element) {
      conversationRowRef.current[conversationId] = element;
      return;
    }
    delete conversationRowRef.current[conversationId];
  }

  function clearReorderPress(conversationId?: string, pointerId?: number): { triggered: boolean } {
    const current = reorderPressRef.current;
    if (!current) {
      return { triggered: false };
    }

    if (
      (conversationId !== undefined && current.conversationId !== conversationId) ||
      (pointerId !== undefined && current.pointerId !== pointerId)
    ) {
      return { triggered: false };
    }

    const triggered = current.triggered;
    reorderPressRef.current = null;
    setPressingReorderConversationId((value) => (value === current.conversationId ? null : value));
    if (triggered) {
      setDraggingConversationId((value) => (value === current.conversationId ? null : value));
    }
    return { triggered };
  }

  function resolveClosestConversationId(conversationIds: string[], clientY: number): string | null {
    let closestId: string | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const conversationId of conversationIds) {
      const element = conversationRowRef.current[conversationId];
      if (!element) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - centerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = conversationId;
      }
    }

    return closestId;
  }

  function handleReorderHandlePointerDown(
    project: ProjectEntry,
    providerId: ProviderId,
    conversationId: string,
    event: React.PointerEvent<HTMLButtonElement>
  ): void {
    if (event.button !== 0 || deleteConversationPendingId !== null || deleteProjectPendingId !== null) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    clearLongPress();
    clearReorderPress();
    closeAllSwipeRows();

    const pointerId = event.pointerId;
    reorderPressRef.current = {
      projectId: project.id,
      providerId,
      conversationId,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      triggered: false,
      lastTargetConversationId: null
    };
    setPressingReorderConversationId(conversationId);
    event.currentTarget.setPointerCapture?.(pointerId);
  }

  function handleReorderHandlePointerMove(
    project: ProjectEntry,
    providerId: ProviderId,
    providerConversationIds: string[],
    conversationId: string,
    event: React.PointerEvent<HTMLButtonElement>
  ): void {
    const current = reorderPressRef.current;
    if (!current || current.conversationId !== conversationId || current.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();

    if (!current.triggered) {
      const movedX = Math.abs(event.clientX - current.startX);
      const movedY = Math.abs(event.clientY - current.startY);
      if (movedX < REORDER_DRAG_ACTIVATION_DISTANCE && movedY < REORDER_DRAG_ACTIVATION_DISTANCE) {
        return;
      }
      current.triggered = true;
      setDraggingConversationId(conversationId);
    }

    const targetConversationId = resolveClosestConversationId(providerConversationIds, event.clientY);
    if (!targetConversationId || targetConversationId === conversationId || targetConversationId === current.lastTargetConversationId) {
      return;
    }

    current.lastTargetConversationId = targetConversationId;
    void onReorderConversation(project, providerId, conversationId, targetConversationId);
  }

  function handleReorderHandlePointerUp(conversationId: string, event: React.PointerEvent<HTMLButtonElement>): void {
    const { triggered } = clearReorderPress(conversationId, event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.stopPropagation();
    if (triggered) {
      event.preventDefault();
    }
  }

  function handleReorderHandlePointerCancel(conversationId: string, event: React.PointerEvent<HTMLButtonElement>): void {
    clearReorderPress(conversationId, event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.stopPropagation();
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

  async function handlePrimaryAction(): Promise<void> {
    if (!createProviderId || createConversationPending) {
      return;
    }

    closeAllSwipeRows();
    setCreateConversationPending(true);
    try {
      if (!activeProject) {
        openCreateProjectDialog();
        return;
      }

      await onCreateConversation(activeProject, createProviderId);
      if (mobileOpen) {
        onMobileOpenChange(false);
      }
    } finally {
      setCreateConversationPending(false);
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
      if (mobileOpen) {
        onMobileOpenChange(false);
      }
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
      if (mobileOpen) {
        onMobileOpenChange(false);
      }
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '导入历史会话失败');
    } finally {
      setHistoryImportingSessionKey(null);
    }
  }

  const sidebarContent = (
    <>
      <div className="border-b border-zinc-200/80 bg-white/90 px-3 py-2 backdrop-blur-sm">
        <div className="text-xs font-medium text-zinc-500">会话目录</div>
      </div>

      <div className="flex-1 space-y-2.5 overflow-auto p-2.5">
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
            暂无目录。
          </div>
        ) : (
          projects.map((project) => {
            const isActiveProject = project.id === activeProjectId;
            const projectSwipeRowKey = `project:${project.id}`;
            const projectSwipeOffset = swipeOffsets[projectSwipeRowKey] ?? 0;
            const projectDeleteVisible = projectSwipeOffset > 0 || deleteProjectPendingId === project.id;
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
                <div className="relative overflow-hidden rounded-xl">
                  <div
                    className={[
                      'absolute inset-y-0 right-0 flex items-center pr-1.5 transition-opacity',
                      projectDeleteVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        closeAllSwipeRows();
                        setDeleteProjectPendingId(project.id);
                        void onDeleteProject(project).finally(() => {
                          setDeleteProjectPendingId((current) => (current === project.id ? null : current));
                        });
                      }}
                      disabled={deleteProjectPendingId === project.id || deleteConversationPendingId !== null}
                      className="inline-flex h-8 items-center rounded-lg bg-red-500 px-3 text-[11px] font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deleteProjectPendingId === project.id ? '删除中' : '删除'}
                    </button>
                  </div>
                  <div
                    className="relative transition-transform duration-150"
                    style={{
                      transform: `translateX(-${projectSwipeOffset}px)`,
                      touchAction: 'pan-y'
                    }}
                  >
                    <div
                      onPointerDown={(event) => handleLongPressPointerDown(projectSwipeRowKey, event)}
                      onPointerMove={(event) => handleLongPressPointerMove(projectSwipeRowKey, event)}
                      onPointerUp={(event) => handleLongPressPointerUp(projectSwipeRowKey, event)}
                      onPointerCancel={(event) => handleLongPressPointerCancel(projectSwipeRowKey, event)}
                      onPointerLeave={(event) => handleLongPressPointerCancel(projectSwipeRowKey, event)}
                      onMouseDown={(event) => handleLongPressMouseDown(projectSwipeRowKey, event)}
                      onMouseMove={(event) => handleLongPressMouseMove(projectSwipeRowKey, event)}
                      onMouseUp={(event) => handleLongPressMouseUp(projectSwipeRowKey, event)}
                      onMouseLeave={() => handleLongPressMouseLeave(projectSwipeRowKey)}
                      className="w-full min-w-0 rounded-xl text-left"
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
                    </div>
                  </div>
                </div>

                <div className="mt-2 space-y-1">
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
                      const providerConversationIds = conversations
                        .filter((entry) => entry.providerId === conversation.providerId)
                        .map((entry) => entry.id);
                      const conversationDeleteVisible =
                        conversationSwipeOffset > 0 || deleteConversationPendingId === conversation.id;
                      const isDraggingConversation = draggingConversationId === conversation.id;
                      const isReorderHandlePressed = pressingReorderConversationId === conversation.id;
                      const isReorderHandleActive = isDraggingConversation || isReorderHandlePressed;
                      const isActiveConversation =
                        isActiveProject &&
                        conversation.providerId === activeProviderId &&
                        conversation.id === activeConversationId;
                      const conversationToneClass = isActiveConversation
                        ? 'text-zinc-700'
                        : isActiveProject
                          ? 'text-zinc-600'
                          : 'text-zinc-500';
                      return (
                        <div
                          key={conversation.id}
                          className="relative overflow-hidden rounded-xl"
                          ref={(element) => setConversationRowElement(conversation.id, element)}
                        >
                          <div
                            className={[
                              'absolute inset-y-0 right-0 flex items-center pr-1.5 transition-opacity',
                              conversationDeleteVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                            ].join(' ')}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                closeAllSwipeRows();
                                setDeleteConversationPendingId(conversation.id);
                                void onDeleteConversation(project, conversation.providerId, conversation).finally(() => {
                                  setDeleteConversationPendingId((current) => (current === conversation.id ? null : current));
                                });
                              }}
                              disabled={
                                deleteConversationPendingId !== null ||
                                deleteProjectPendingId !== null
                              }
                              className="inline-flex h-8 items-center rounded-lg bg-red-500 px-3 text-[11px] font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deleteConversationPendingId === conversation.id ? '删除中' : '删除'}
                            </button>
                          </div>
                          <div
                            className="relative transition-transform duration-150"
                            style={{
                              transform: `translateX(-${conversationSwipeOffset}px)`,
                              touchAction: 'pan-y'
                            }}
                          >
                            <div
                              className={[
                                'flex items-stretch gap-1.5 transition-transform duration-150',
                                isReorderHandleActive ? 'z-10 scale-[1.01]' : ''
                              ].join(' ')}
                            >
                              <button
                                type="button"
                                aria-label="拖动会话排序"
                                title="拖动会话排序"
                                onPointerDown={(event) =>
                                  handleReorderHandlePointerDown(project, conversation.providerId, conversation.id, event)
                                }
                                onPointerMove={(event) =>
                                  handleReorderHandlePointerMove(
                                    project,
                                    conversation.providerId,
                                    providerConversationIds,
                                    conversation.id,
                                    event
                                  )
                                }
                                onPointerUp={(event) => handleReorderHandlePointerUp(conversation.id, event)}
                                onPointerCancel={(event) => handleReorderHandlePointerCancel(conversation.id, event)}
                                className={[
                                  '-ml-1 inline-flex w-5 shrink-0 items-center justify-center bg-transparent p-1 transition-all duration-150',
                                  conversationToneClass,
                                  isDraggingConversation
                                    ? 'cursor-grabbing opacity-100'
                                    : isReorderHandlePressed
                                      ? 'cursor-grabbing scale-110 opacity-100'
                                    : 'cursor-grab opacity-70 hover:opacity-100 active:cursor-grabbing'
                                ].join(' ')}
                                disabled={deleteConversationPendingId !== null || deleteProjectPendingId !== null}
                              >
                                <span className="grid grid-cols-2 gap-[2px]">
                                  {Array.from({ length: 6 }).map((_, dotIndex) => (
                                    <span key={dotIndex} className="h-[3px] w-[3px] rounded-full bg-current" />
                                  ))}
                                </span>
                              </button>

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
                                }}
                                className={[
                                  'block min-w-0 flex-1 rounded-xl border px-2.5 py-2 text-left transition',
                                  isActiveConversation
                                    ? isActiveProject
                                      ? 'border-zinc-300 bg-white text-zinc-950 shadow-sm'
                                      : 'border-sky-200 bg-sky-100 text-zinc-950'
                                    : isActiveProject
                                      ? 'border-transparent bg-transparent text-zinc-800 hover:bg-white/70'
                                      : 'border-transparent bg-transparent text-zinc-800 hover:bg-zinc-100',
                                  isReorderHandleActive ? 'border-zinc-300/80 shadow-md' : ''
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
            if (event.pointerType === 'mouse' && event.button !== 0) {
              return;
            }
            event.preventDefault();
            onMobileOpenChange(false);
          }}
          onClick={(event) => {
            if (event.detail !== 0) {
              return;
            }
            onMobileOpenChange(false);
          }}
          className={[
            'absolute inset-0 bg-black/18 backdrop-blur-[1px] transition-opacity duration-300',
            mobileOpen ? 'opacity-100' : 'opacity-0'
          ].join(' ')}
        />

        <aside
          className={[
            'absolute top-0 left-0 flex h-full w-[20rem] max-w-[82vw] flex-col border-r border-zinc-200 bg-white shadow-[0_18px_60px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out',
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          ].join(' ')}
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
                  className="shrink-0 rounded-xl border border-zinc-300 px-3 py-2.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
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
    </>
  );
}
