interface TerminalPaneProps {
  hostRef: React.RefObject<HTMLDivElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  onJumpToEdge: (direction: 'up' | 'down') => void;
}

export function TerminalPane({ hostRef, viewportRef, visible, onJumpToEdge }: TerminalPaneProps) {
  return (
    <div
      className={[
        'relative flex min-h-[22rem] min-w-0 flex-1 flex-col overflow-hidden bg-transparent sm:min-h-[24rem] lg:min-h-[28rem] lg:rounded-3xl lg:border lg:border-zinc-200 lg:bg-white lg:shadow-sm',
        visible ? 'flex' : 'hidden lg:flex'
      ].join(' ')}
    >
      <div className="hidden px-3 py-3 sm:px-4 lg:block lg:border-b lg:border-zinc-200">
        <h2 className="text-lg font-semibold">Terminal</h2>
      </div>
      <div className="terminal-shell min-w-0 flex-1 overflow-hidden bg-transparent p-0 sm:p-2 lg:rounded-b-3xl lg:bg-white lg:p-3">
        <div ref={viewportRef} className="h-full overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x">
          <div ref={hostRef} className="h-full min-w-full overflow-hidden bg-transparent lg:bg-white" />
        </div>
      </div>

      <div className="pointer-events-none absolute right-3 bottom-14 z-10 md:right-4 md:bottom-16">
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-zinc-200/80 bg-white/65 shadow-[0_8px_20px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <button
            type="button"
            onClick={() => onJumpToEdge('up')}
            className="flex h-8 w-8 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900 md:h-9 md:w-9"
            aria-label="终端直达顶部"
            title="终端直达顶部"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
              <path d="M5 12l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="h-px bg-zinc-200/80" />
          <button
            type="button"
            onClick={() => onJumpToEdge('down')}
            className="flex h-8 w-8 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900 md:h-9 md:w-9"
            aria-label="终端直达底部"
            title="终端直达底部"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
              <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
