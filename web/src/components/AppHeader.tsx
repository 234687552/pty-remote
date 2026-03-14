import type { WorkspacePane } from '@/features/workspace/types.ts';

interface AppHeaderProps {
  mobilePane: WorkspacePane;
  mobileTitleVisible: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarToggle: () => void;
  sidebarCollapsed: boolean;
  summary: string[];
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[18px] w-[18px]">
      <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      {collapsed ? (
        <path d="M8.2 4.5v11M10.8 7.3l2.2 2.7-2.2 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M8.2 4.5v11M12.8 7.3 10.6 10l2.2 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function MobilePaneIcon({ pane }: { pane: WorkspacePane }) {
  if (pane === 'terminal') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[18px] w-[18px]">
        <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.8 8.2 8.9 10l-2.1 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.8 11.9h2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[18px] w-[18px]">
      <path
        d="M4.5 6.5A2.5 2.5 0 0 1 7 4h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 13 12H9.8l-2.9 2.5c-.7.6-1.7.1-1.7-.8V12A2.5 2.5 0 0 1 4.5 9.5v-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppHeader({
  mobilePane,
  mobileTitleVisible,
  onMobilePaneChange,
  onSidebarToggle,
  sidebarCollapsed,
  summary
}: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 -mb-3 h-0 pointer-events-none lg:static lg:mb-0 lg:h-auto lg:pointer-events-auto">
      <div
        className="mx-4 flex flex-col items-center gap-1.5 px-0 py-2 lg:hidden"
        style={{
          paddingTop: 'max(env(safe-area-inset-top), 0.25rem)',
          paddingLeft: 'max(env(safe-area-inset-left), 0px)',
          paddingRight: 'max(env(safe-area-inset-right), 0px)'
        }}
      >
        <div
          className={[
            'inline-flex items-center gap-1 rounded-full border border-zinc-200/70 bg-white/82 p-1.5 shadow-[0_10px_28px_rgba(0,0,0,0.08)] backdrop-blur-md transition-all duration-200 ease-out',
            mobileTitleVisible ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none -translate-y-8 opacity-0'
          ].join(' ')}
        >
          <button
            type="button"
            onClick={onSidebarToggle}
            className={[
              'flex h-10 w-10 items-center justify-center rounded-full transition',
              !sidebarCollapsed
                ? 'bg-zinc-900 text-white shadow-[0_8px_24px_rgba(24,24,27,0.18)]'
                : 'bg-white/78 text-zinc-500 shadow-[0_4px_14px_rgba(255,255,255,0.32)] hover:bg-white hover:text-zinc-900'
            ].join(' ')}
            aria-label={sidebarCollapsed ? '打开边栏' : '收起边栏'}
            title={sidebarCollapsed ? '打开边栏' : '收起边栏'}
            aria-pressed={!sidebarCollapsed}
          >
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </button>
          <div
            className="h-10 w-px bg-zinc-200/80"
            aria-hidden="true"
          />
          {(
            [
              ['chat', '切换到对话'],
              ['terminal', '切换到终端']
            ] as const satisfies ReadonlyArray<readonly [WorkspacePane, string]>
          ).map(([pane, label]) => (
            <button
              key={pane}
              type="button"
              onClick={() => onMobilePaneChange(pane)}
              className={[
                'flex h-10 w-10 items-center justify-center rounded-full transition',
                mobilePane === pane
                  ? 'bg-zinc-900 text-white shadow-[0_8px_24px_rgba(24,24,27,0.18)]'
                  : 'bg-white/78 text-zinc-500 shadow-[0_4px_14px_rgba(255,255,255,0.32)] hover:bg-white hover:text-zinc-900'
              ].join(' ')}
              aria-label={label}
              title={label}
              aria-pressed={mobilePane === pane}
            >
              <MobilePaneIcon pane={pane} />
            </button>
          ))}
        </div>
      </div>

      <div className="mx-0 hidden rounded-3xl border border-zinc-200 bg-white px-4 py-3 shadow-sm lg:block">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSidebarToggle}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-zinc-300 bg-white text-zinc-700 shadow-sm transition hover:bg-zinc-50"
            aria-label={sidebarCollapsed ? '打开边栏' : '收起边栏'}
            title={sidebarCollapsed ? '打开边栏' : '收起边栏'}
            aria-pressed={!sidebarCollapsed}
          >
            <SidebarToggleIcon collapsed={sidebarCollapsed} />
          </button>

          <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm text-zinc-600 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-zinc-900">pty-remote</span>
              {summary.map((item) => (
                <span key={item} className="flex items-center gap-3">
                  <span className="text-zinc-300">/</span>
                  <span>{item}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
