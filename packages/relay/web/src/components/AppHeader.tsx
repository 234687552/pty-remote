import type { SetStateAction } from 'react';
import { PROVIDER_LABELS, type ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

interface AppHeaderProps {
  activeProviderId: ProviderId | null;
  onSidebarToggle: () => void;
  onSidebarToggleTopChange: (value: SetStateAction<number>) => void;
  onSidebarToggleTopCommit: (value: number) => void;
  sidebarCollapsed: boolean;
  sidebarToggleTop: number;
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

export function AppHeader({
  activeProviderId,
  onSidebarToggle,
  onSidebarToggleTopChange: _onSidebarToggleTopChange,
  onSidebarToggleTopCommit: _onSidebarToggleTopCommit,
  sidebarCollapsed,
  sidebarToggleTop: _sidebarToggleTop,
  summary
}: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 -mb-3 h-0 pointer-events-none lg:static lg:mb-0 lg:h-auto lg:pointer-events-auto">
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
              <span
                className={[
                  'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                  activeProviderId ? providerBadgeClass(activeProviderId) : 'border-zinc-200 bg-zinc-100 text-zinc-600'
                ].join(' ')}
              >
                {activeProviderId ? PROVIDER_LABELS[activeProviderId] : '未选择 Provider'}
              </span>
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
