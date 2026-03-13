export type WorkspacePane = 'chat' | 'terminal';

interface MobilePaneTabsProps {
  activePane: WorkspacePane;
  onChange: (pane: WorkspacePane) => void;
}

export function MobilePaneTabs({ activePane, onChange }: MobilePaneTabsProps) {
  return (
    <nav className="mx-4 rounded-2xl border border-zinc-200 bg-white p-1 shadow-sm lg:hidden" aria-label="Mobile panels">
      <div className="grid grid-cols-2 gap-1">
        {(
          [
            ['chat', 'Chat'],
            ['terminal', 'Terminal']
          ] as const satisfies ReadonlyArray<readonly [WorkspacePane, string]>
        ).map(([pane, label]) => (
          <button
            key={pane}
            type="button"
            onClick={() => onChange(pane)}
            className={[
              'rounded-xl px-3 py-2 text-sm font-medium transition',
              activePane === pane ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            ].join(' ')}
            aria-pressed={activePane === pane}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
