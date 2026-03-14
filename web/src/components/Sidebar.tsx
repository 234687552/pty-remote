import type { CliDescriptor } from '@shared/runtime-types.ts';

import type { ProjectEntry, ProjectThreadEntry } from '@/lib/workspace.ts';

interface SidebarProps {
  activeCliId: string | null;
  activeProjectId: string | null;
  activeThreadId: string | null;
  clis: CliDescriptor[];
  collapsed: boolean;
  projectThreadsById: Record<string, ProjectThreadEntry[]>;
  projects: ProjectEntry[];
  projectsRefreshing: boolean;
  onActivateThread: (project: ProjectEntry, thread: ProjectThreadEntry) => void;
  onAddProject: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreateThread: (projectId: string) => void;
  onRefreshAllProjects: () => void;
  onSelectCli: (cliId: string | null) => void;
  onSelectProject: (project: ProjectEntry, firstThreadId: string | null) => void;
}

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
  activeThreadId,
  clis,
  collapsed,
  projectThreadsById,
  projects,
  projectsRefreshing,
  onActivateThread,
  onAddProject,
  onCollapsedChange,
  onCreateThread,
  onRefreshAllProjects,
  onSelectCli,
  onSelectProject
}: SidebarProps) {
  const sidebarContent = (
    <>
      <div className="flex-1 space-y-2.5 overflow-auto p-2.5 pt-2.5">
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
            先添加一个项目目录，再在目录下切换历史 thread 或创建新 thread。
          </div>
        ) : (
          projects.map((project) => {
            const isActiveProject = project.id === activeProjectId;
            const projectThreads = (projectThreadsById[project.id] ?? []).slice(0, 5);
            const projectCli = clis.find((entry) => entry.cliId === project.cliId) ?? null;
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
                    onClick={() => onSelectProject(project, projectThreads[0]?.id ?? null)}
                    className="min-w-0 text-left"
                  >
                    <div className="truncate text-[13px] font-semibold">{project.label}</div>
                    <div className={['mt-0.5 line-clamp-1 text-[11px]', isActiveProject ? 'text-zinc-600' : 'text-zinc-500'].join(' ')}>
                      {project.cwd}
                    </div>
                    <div className={['mt-0.5 text-[10px]', isActiveProject ? 'text-zinc-600' : 'text-zinc-500'].join(' ')}>
                      {projectCli?.label ?? project.cliId}
                    </div>
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onCreateThread(project.id)}
                      className={[
                        'flex h-8 w-8 items-center justify-center rounded-lg border transition',
                        isActiveProject
                          ? 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
                          : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
                      ].join(' ')}
                      aria-label="新线程"
                      title="新线程"
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                        <path d="M10 4v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        <path d="M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="mt-2 space-y-1">
                  {projectThreads.length === 0 ? (
                    <div
                      className={[
                        'rounded-xl border px-2.5 py-2 text-[11px]',
                        isActiveProject ? 'border-zinc-300 bg-white/70 text-zinc-600' : 'border-zinc-200 text-zinc-500'
                      ].join(' ')}
                    >
                      这个 project 还没有可用 thread。
                    </div>
                  ) : (
                    projectThreads.map((thread) => {
                      const isActiveThread = isActiveProject && thread.id === activeThreadId;
                      return (
                        <button
                          key={thread.id}
                          type="button"
                          onClick={() => onActivateThread(project, thread)}
                          className={[
                            'block w-full rounded-xl border px-2.5 py-2 text-left transition',
                            isActiveThread
                              ? isActiveProject
                                ? 'border-zinc-300 bg-white text-zinc-950 shadow-sm'
                                : 'border-sky-200 bg-sky-100 text-zinc-950'
                              : isActiveProject
                                ? 'border-transparent bg-transparent text-zinc-800 hover:bg-white/70'
                                : 'border-transparent bg-transparent text-zinc-800 hover:bg-zinc-100'
                          ].join(' ')}
                        >
                          <div className="truncate text-[13px] font-medium">{thread.title}</div>
                          <div
                            className={[
                              'mt-1 flex items-center justify-between gap-3 text-[10px]',
                              isActiveThread ? (isActiveProject ? 'text-zinc-600' : 'text-zinc-700') : isActiveProject ? 'text-zinc-500' : 'text-zinc-500'
                            ].join(' ')}
                          >
                            <span className="min-w-0 truncate" title={thread.sessionId ?? 'new'}>
                              {thread.sessionId ?? 'new'}
                            </span>
                            <span className="shrink-0" title={new Date(thread.updatedAt).toLocaleString()}>
                              {formatRelativeTime(thread.updatedAt)}
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
                {entry.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={onAddProject}
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
          collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
        ].join(' ')}
      >
        <button
          type="button"
          aria-label="关闭边栏蒙版"
          onClick={() => onCollapsedChange(true)}
          className={[
            'absolute inset-0 bg-black/18 backdrop-blur-[1px] transition-opacity duration-300',
            collapsed ? 'opacity-0' : 'opacity-100'
          ].join(' ')}
        />

        <aside
          className={[
            'absolute top-0 left-0 flex h-full w-[20rem] max-w-[82vw] flex-col border-r border-zinc-200 bg-white shadow-[0_18px_60px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out',
            collapsed ? '-translate-x-full' : 'translate-x-0'
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
    </>
  );
}
