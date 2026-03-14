import type { WorkspacePane } from '@/features/workspace/types.ts';

interface MobilePaneTabsProps {
  activePane: WorkspacePane;
  className?: string;
  compact?: boolean;
  onChange: (pane: WorkspacePane) => void;
}

function MobilePaneIcon({ pane }: { pane: WorkspacePane }) {
  if (pane === 'terminal') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[15px] w-[15px]">
        <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.8 8.2 8.9 10l-2.1 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.8 11.9h2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-[15px] w-[15px]">
      <path
        d="M4.5 6.5A2.5 2.5 0 0 1 7 4h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 13 12H9.8l-2.9 2.5c-.7.6-1.7.1-1.7-.8V12A2.5 2.5 0 0 1 4.5 9.5v-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MobilePaneTabs({ activePane, className, compact = false, onChange }: MobilePaneTabsProps) {
  const items = compact
    ? (
        [
          ['chat', '切换到消息'],
          ['terminal', '切换到终端']
        ] as const satisfies ReadonlyArray<readonly [WorkspacePane, string]>
      )
    : (
        [
          ['chat', 'Messages'],
          ['terminal', 'Terminal']
        ] as const satisfies ReadonlyArray<readonly [WorkspacePane, string]>
      );

  return (
    <nav
      className={['rounded-2xl border border-zinc-200 bg-white p-1 shadow-sm lg:hidden', className ?? ''].join(' ').trim()}
      aria-label="Mobile panels"
    >
      <div className="grid grid-cols-2 gap-1">
        {items.map(([pane, label]) => (
          <button
            key={pane}
            type="button"
            onClick={() => onChange(pane)}
            className={[
              compact
                ? 'flex h-8 w-8 items-center justify-center rounded-xl transition'
                : 'rounded-xl px-3 py-2 text-sm font-medium transition',
              activePane === pane ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            ].join(' ')}
            aria-pressed={activePane === pane}
            aria-label={label}
            title={label}
          >
            {compact ? <MobilePaneIcon pane={pane} /> : label}
          </button>
        ))}
      </div>
    </nav>
  );
}
