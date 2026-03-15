import { useEffect, useRef, useState } from 'react';

import { PROVIDER_LABELS, PROVIDER_ORDER, type CliDescriptor, type ProviderId } from '@shared/runtime-types.ts';

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
  projectsRefreshing: boolean;
  onActivateConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => void;
  onAddProject: (input: { cwd: string; providerId: ProviderId }) => Promise<void>;
  onDeleteProject: (project: ProjectEntry) => Promise<void>;
  onPickProjectDirectory: (providerId: ProviderId) => Promise<string | null>;
  onMobileOpenChange: (open: boolean) => void;
  onRefreshProjectConversations: (project: ProjectEntry, providerId: ProviderId) => Promise<void>;
  onRefreshAllProjects: () => void;
  onSelectCli: (cliId: string | null) => void;
  onSelectProject: (project: ProjectEntry) => void;
}

const PROJECT_DELETE_LONG_PRESS_DELAY_MS = 650;

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
  projectsRefreshing,
  onActivateConversation,
  onAddProject,
  onDeleteProject,
  onPickProjectDirectory,
  onMobileOpenChange,
  onRefreshProjectConversations,
  onRefreshAllProjects,
  onSelectCli,
  onSelectProject
}: SidebarProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>(activeProviderId ?? PROVIDER_ORDER[0]);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [draftCwd, setDraftCwd] = useState('');
  const [draftProviderId, setDraftProviderId] = useState<ProviderId>(activeProviderId ?? 'claude');
  const [addProjectPending, setAddProjectPending] = useState(false);
  const [pickDirectoryPending, setPickDirectoryPending] = useState(false);
  const [deleteProjectPendingId, setDeleteProjectPendingId] = useState<string | null>(null);
  const [addProjectError, setAddProjectError] = useState('');
  const projectDeletePressTimeoutRef = useRef<number | null>(null);
  const longPressTriggeredProjectIdRef = useRef<string | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const sidebarVisible = mobileOpen || !collapsed;
  const connectedCliKeyForSelectedProvider = clis
    .filter((cli) => cli.connected && cli.supportedProviders.includes(selectedProviderId))
    .map((cli) => cli.cliId)
    .join('|');

  useEffect(() => {
    return () => {
      if (projectDeletePressTimeoutRef.current !== null) {
        window.clearTimeout(projectDeletePressTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isAddDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !addProjectPending && !pickDirectoryPending) {
        setIsAddDialogOpen(false);
        setAddProjectError('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [addProjectPending, isAddDialogOpen, pickDirectoryPending]);

  useEffect(() => {
    if (!isAddDialogOpen) {
      return;
    }

    setDraftProviderId(activeProviderId ?? 'claude');
  }, [activeProviderId, isAddDialogOpen]);

  useEffect(() => {
    if (!sidebarVisible || !activeProject) {
      return;
    }

    void onRefreshProjectConversations(activeProject, selectedProviderId);
  }, [activeProject?.cwd, activeProject?.id, connectedCliKeyForSelectedProvider, selectedProviderId, sidebarVisible]);

  function handleProviderTabSelect(providerId: ProviderId): void {
    setSelectedProviderId(providerId);
  }

  function clearProjectDeletePressTimeout(): void {
    if (projectDeletePressTimeoutRef.current !== null) {
      window.clearTimeout(projectDeletePressTimeoutRef.current);
      projectDeletePressTimeoutRef.current = null;
    }
  }

  function handleProjectPressStart(project: ProjectEntry, event: React.PointerEvent<HTMLButtonElement>): void {
    if (deleteProjectPendingId !== null) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    clearProjectDeletePressTimeout();
    longPressTriggeredProjectIdRef.current = null;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    projectDeletePressTimeoutRef.current = window.setTimeout(() => {
      projectDeletePressTimeoutRef.current = null;
      longPressTriggeredProjectIdRef.current = project.id;
      const confirmed = window.confirm(`删除项目“${project.label}”？`);
      if (!confirmed) {
        return;
      }

      setDeleteProjectPendingId(project.id);
      void onDeleteProject(project).finally(() => {
        setDeleteProjectPendingId((current) => (current === project.id ? null : current));
      });
    }, PROJECT_DELETE_LONG_PRESS_DELAY_MS);
  }

  function handleProjectPressEnd(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearProjectDeletePressTimeout();
  }

  function handleProjectPressCancel(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearProjectDeletePressTimeout();
  }

  function openAddProjectDialog(): void {
    setDraftCwd('');
    setDraftProviderId(activeProviderId ?? 'claude');
    setAddProjectError('');
    setIsAddDialogOpen(true);
  }

  function closeAddProjectDialog(): void {
    if (addProjectPending || pickDirectoryPending) {
      return;
    }
    setIsAddDialogOpen(false);
    setAddProjectError('');
  }

  async function handlePickDirectory(): Promise<void> {
    setAddProjectError('');
    setPickDirectoryPending(true);
    try {
      const cwd = await onPickProjectDirectory(draftProviderId);
      if (cwd) {
        setDraftCwd(cwd);
      }
    } catch (error) {
      setAddProjectError(error instanceof Error ? error.message : '选择目录失败');
    } finally {
      setPickDirectoryPending(false);
    }
  }

  async function handleAddProjectSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const normalizedCwd = draftCwd.trim();
    if (!normalizedCwd) {
      setAddProjectError('目录路径不能为空');
      return;
    }

    setAddProjectPending(true);
    setAddProjectError('');
    try {
      await onAddProject({
        cwd: normalizedCwd,
        providerId: draftProviderId
      });
      setIsAddDialogOpen(false);
    } catch (error) {
      setAddProjectError(error instanceof Error ? error.message : '添加项目失败');
    } finally {
      setAddProjectPending(false);
    }
  }

  const sidebarContent = (
    <>
      <div className="border-b border-zinc-200/80 bg-white/90 px-3 pt-2 pb-1.5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          {PROVIDER_ORDER.map((providerId) => {
            const selected = selectedProviderId === providerId;
            return (
              <button
                key={providerId}
                type="button"
                onClick={() => handleProviderTabSelect(providerId)}
                className={[
                  'border-b-2 px-1.5 pb-2 text-xs font-medium transition',
                  selected
                    ? 'border-zinc-900 text-zinc-900'
                    : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800'
                ].join(' ')}
                aria-pressed={selected}
              >
                {PROVIDER_LABELS[providerId]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 space-y-2.5 overflow-auto p-2.5">
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
            先添加一个项目目录，再在目录下切换历史 conversation。
          </div>
        ) : (
          projects.map((project) => {
            const isActiveProject = project.id === activeProjectId;
            const allConversations =
              selectedProviderId ? projectConversationsByKey[getProjectProviderKey(project.id, selectedProviderId)] ?? [] : [];
            const conversations = allConversations.slice(0, 5);

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
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (longPressTriggeredProjectIdRef.current === project.id) {
                        longPressTriggeredProjectIdRef.current = null;
                        return;
                      }
                      onSelectProject(project);
                    }}
                    onPointerDown={(event) => handleProjectPressStart(project, event)}
                    onPointerUp={handleProjectPressEnd}
                    onPointerCancel={handleProjectPressCancel}
                    onPointerLeave={handleProjectPressCancel}
                    className="min-w-0 text-left"
                    disabled={deleteProjectPendingId === project.id}
                    title="长按删除项目"
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
                  {deleteProjectPendingId === project.id ? (
                    <span className="shrink-0 text-[10px] font-medium text-zinc-500">删除中...</span>
                  ) : null}
                </div>

                <div className="mt-2 space-y-1">
                  {conversations.length === 0 ? (
                    <div
                      className={[
                        'rounded-xl border px-2.5 py-2 text-[11px]',
                        isActiveProject ? 'border-zinc-300 bg-white/70 text-zinc-600' : 'border-zinc-200 text-zinc-500'
                      ].join(' ')}
                    >
                      {selectedProviderId
                        ? `这个目录在 ${PROVIDER_LABELS[selectedProviderId]} 下还没有可用 conversation。`
                        : '这个目录还没有可用 conversation。'}
                    </div>
                  ) : (
                    conversations.map((conversation) => {
                      const isActiveConversation =
                        isActiveProject &&
                        selectedProviderId === activeProviderId &&
                        conversation.id === activeConversationId;
                      return (
                        <button
                          key={conversation.id}
                          type="button"
                          onClick={() => onActivateConversation(project, conversation.providerId, conversation)}
                          className={[
                            'block w-full rounded-xl border px-2.5 py-2 text-left transition',
                            isActiveConversation
                              ? isActiveProject
                                ? 'border-zinc-300 bg-white text-zinc-950 shadow-sm'
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
                        </button>
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
                {entry.label} ({entry.supportedProviders.join(' / ')})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={openAddProjectDialog}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white transition hover:bg-zinc-700"
            aria-label="添加项目"
            title="添加项目"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
              <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onRefreshAllProjects}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-300 text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={projectsRefreshing ? '刷新中' : '刷新全部项目'}
            title={projectsRefreshing ? '刷新中' : '刷新全部项目'}
            disabled={projectsRefreshing}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={['h-4 w-4', projectsRefreshing ? 'animate-spin' : ''].join(' ')}>
              <path
                d="M16 10a6 6 0 1 1-1.66-4.14"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M16 4.5v3.8h-3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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

      {isAddDialogOpen ? (
        <div className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-sm" onClick={closeAddProjectDialog}>
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
              className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-5 shadow-[0_24px_90px_rgba(15,23,42,0.22)]"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <form className="space-y-4" onSubmit={(event) => void handleAddProjectSubmit(event)}>
                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">目录路径</span>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      value={draftCwd}
                      onChange={(event) => setDraftCwd(event.target.value)}
                      placeholder="/Users/name/project"
                      className="min-w-0 flex-1 rounded-2xl border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-500"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => void handlePickDirectory()}
                      disabled={pickDirectoryPending || addProjectPending}
                      className="hidden shrink-0 rounded-2xl border border-zinc-300 px-3 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
                    >
                      {pickDirectoryPending ? '选择中...' : '选择目录'}
                    </button>
                  </div>
                </label>

                <fieldset>
                  <div className="grid grid-cols-2 gap-2">
                    {(['claude', 'codex'] as ProviderId[]).map((providerId) => {
                      const selected = draftProviderId === providerId;
                      return (
                        <button
                          key={providerId}
                          type="button"
                          onClick={() => setDraftProviderId(providerId)}
                          className={[
                            'rounded-2xl border px-3 py-3 text-left transition',
                            selected ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 bg-white text-zinc-900 hover:border-zinc-400'
                          ].join(' ')}
                          aria-pressed={selected}
                        >
                          <div className="text-sm font-semibold">{PROVIDER_LABELS[providerId]}</div>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                {addProjectError ? <div className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{addProjectError}</div> : null}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={closeAddProjectDialog}
                    disabled={addProjectPending || pickDirectoryPending}
                    className="rounded-2xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={addProjectPending || pickDirectoryPending}
                    className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {addProjectPending ? '添加中...' : '添加'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
