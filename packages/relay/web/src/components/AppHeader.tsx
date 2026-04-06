import { PROVIDER_LABELS, type ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

interface AppHeaderProps {
  activeProviderId: ProviderId | null;
  desktopTerminalEnabled: boolean;
  desktopTerminalOpen: boolean;
  desktopWorkspaceBrowserEnabled: boolean;
  desktopWorkspaceBrowserOpen: boolean;
  onDesktopTerminalToggle: () => void;
  onDesktopWorkspaceBrowserToggle: () => void;
  onSidebarToggle: () => void;
  sidebarCollapsed: boolean;
  summary: string[];
}

function providerBadgeClass(providerId: ProviderId): string {
  return providerId === 'claude'
    ? 'bg-orange-100 text-orange-700 border-orange-200'
    : 'bg-emerald-100 text-emerald-700 border-emerald-200';
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

function WorkspaceBrowserIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[18px] w-[18px]">
      <path d="M6.15 3.75h5.45L15 7.15v8.1a1 1 0 0 1-1 1H6.15a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M11.6 3.75V7.1H15" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M7.75 10.1h4.55M7.75 12.9h4.55" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[18px] w-[18px]">
      <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.7 8.1 8.9 10l-2.2 1.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.7 11.95h2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function AppHeader({
  activeProviderId,
  desktopTerminalEnabled,
  desktopTerminalOpen,
  desktopWorkspaceBrowserEnabled,
  desktopWorkspaceBrowserOpen,
  onDesktopTerminalToggle,
  onDesktopWorkspaceBrowserToggle,
  onSidebarToggle,
  sidebarCollapsed,
  summary
}: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 -mb-3 h-0 pointer-events-none lg:static lg:mb-0 lg:h-auto lg:pointer-events-auto">
      <div className="mx-0 hidden rounded-3xl border border-zinc-200 bg-white px-4 py-3 shadow-sm lg:block">
        <div className="flex items-center gap-3">
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onSidebarToggle}
              className="flex h-10 w-10 items-center justify-center rounded-2xl border border-zinc-300 bg-white text-zinc-700 shadow-sm transition hover:bg-zinc-50"
              aria-label={sidebarCollapsed ? '打开边栏' : '收起边栏'}
              title={sidebarCollapsed ? '打开边栏' : '收起边栏'}
              aria-pressed={!sidebarCollapsed}
            >
              <SidebarToggleIcon collapsed={sidebarCollapsed} />
            </button>

            <button
              type="button"
              onClick={onDesktopTerminalToggle}
              disabled={!desktopTerminalEnabled}
              className={[
                'flex h-10 w-10 items-center justify-center rounded-2xl border shadow-sm transition',
                desktopTerminalOpen
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50',
                desktopTerminalEnabled ? '' : 'cursor-not-allowed opacity-45 shadow-none'
              ].join(' ')}
              aria-label={desktopTerminalOpen ? '关闭实时终端' : '打开实时终端'}
              title={desktopTerminalOpen ? '关闭实时终端' : '打开实时终端'}
              aria-pressed={desktopTerminalOpen}
            >
              <TerminalIcon />
            </button>

            <button
              type="button"
              onClick={onDesktopWorkspaceBrowserToggle}
              disabled={!desktopWorkspaceBrowserEnabled}
              className={[
                'flex h-10 w-10 items-center justify-center rounded-2xl border shadow-sm transition',
                desktopWorkspaceBrowserOpen
                  ? 'border-sky-200 bg-sky-50 text-sky-700'
                  : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50',
                desktopWorkspaceBrowserEnabled ? '' : 'cursor-not-allowed opacity-45 shadow-none'
              ].join(' ')}
              aria-label={desktopWorkspaceBrowserOpen ? '关闭 Git Diff 和目录浏览' : '打开 Git Diff 和目录浏览'}
              title={desktopWorkspaceBrowserOpen ? '关闭 Git Diff 和目录浏览' : '打开 Git Diff 和目录浏览'}
              aria-pressed={desktopWorkspaceBrowserOpen}
            >
              <WorkspaceBrowserIcon />
            </button>
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0 text-base font-semibold text-zinc-900">pty-remote</div>
              </div>
              <span
                className={[
                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                  activeProviderId ? providerBadgeClass(activeProviderId) : 'border-zinc-200 bg-zinc-100 text-zinc-600'
                ].join(' ')}
              >
                {activeProviderId ? PROVIDER_LABELS[activeProviderId] : '未选择 Provider'}
              </span>
              {summary.map((item, index) => (
                <div key={`${item}:${index}`} className="flex min-w-0 items-center gap-3 text-sm text-zinc-500">
                  <span className="text-zinc-300">/</span>
                  <span className="truncate">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
