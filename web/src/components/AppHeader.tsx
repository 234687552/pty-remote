import type { WorkspacePane } from '@/features/workspace/types.ts';

interface AppHeaderProps {
  mobilePane: WorkspacePane;
  mobileTitle: string;
  mobileTitleVisible: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  summary: string[];
}

function MobilePaneIcon({ pane }: { pane: WorkspacePane }) {
  if (pane === 'terminal') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
        <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.8 8.2 8.9 10l-2.1 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.8 11.9h2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
      <path
        d="M4.5 6.5A2.5 2.5 0 0 1 7 4h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 13 12H9.8l-2.9 2.5c-.7.6-1.7.1-1.7-.8V12A2.5 2.5 0 0 1 4.5 9.5v-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppHeader({ mobilePane, mobileTitle, mobileTitleVisible, onMobilePaneChange, summary }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 -mb-3 h-0 pointer-events-none lg:static lg:mb-0 lg:h-auto lg:pointer-events-auto">
      <div
        className="mx-4 flex items-start justify-between gap-3 px-0 py-2 lg:hidden"
        style={{
          paddingTop: 'max(env(safe-area-inset-top), 0.25rem)',
          paddingLeft: 'max(env(safe-area-inset-left), 0px)',
          paddingRight: 'max(env(safe-area-inset-right), 0px)'
        }}
      >
        <div className="min-w-0 flex-1 overflow-hidden pt-2">
          <div className="h-10 overflow-hidden">
            <div
              className={[
                'inline-flex max-w-full items-center rounded-full border border-zinc-200/80 bg-white/88 px-4 py-2 text-[15px] font-semibold tracking-[-0.01em] text-zinc-900 shadow-[0_10px_28px_rgba(0,0,0,0.08)] backdrop-blur-md transition-all duration-200 ease-out',
                mobileTitleVisible ? 'translate-y-0 opacity-100' : '-translate-y-6 opacity-0'
              ].join(' ')}
            >
              <span className="block max-w-[min(56vw,15rem)] truncate">{mobileTitle}</span>
            </div>
          </div>
        </div>
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-zinc-200/70 bg-white/82 p-1 shadow-[0_10px_28px_rgba(0,0,0,0.08)] backdrop-blur-md">
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
                'flex h-9 w-9 items-center justify-center rounded-full transition',
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
        <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap text-sm text-zinc-600 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <span className="text-base font-semibold text-zinc-900">pty-remote</span>
          {summary.map((item) => (
            <span key={item} className="flex items-center gap-3">
              <span className="text-zinc-300">/</span>
              <span>{item}</span>
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}
