import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, SetStateAction } from 'react';

import type { WorkspacePane } from '@/features/workspace/types.ts';
import { clampSidebarToggleTop } from '@/lib/workspace.ts';

interface AppHeaderProps {
  mobileAgentLabel: string;
  mobilePane: WorkspacePane;
  mobileProjectTitle: string;
  mobileTitleVisible: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarToggle: () => void;
  onSidebarToggleTopChange: (value: SetStateAction<number>) => void;
  onSidebarToggleTopCommit: (value: number) => void;
  sidebarCollapsed: boolean;
  sidebarToggleTop: number;
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

function FloatingToggleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
      <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.2 4.5v11M10.8 7.3l2.2 2.7-2.2 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MobilePaneIcon({ pane }: { pane: WorkspacePane }) {
  if (pane === 'terminal') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-6 w-6">
        <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.8 8.2 8.9 10l-2.1 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.8 11.9h2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-6 w-6">
      <path
        d="M4.5 6.5A2.5 2.5 0 0 1 7 4h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 13 12H9.8l-2.9 2.5c-.7.6-1.7.1-1.7-.8V12A2.5 2.5 0 0 1 4.5 9.5v-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface DragState {
  pointerId: number;
  startTop: number;
  startY: number;
}

export function AppHeader({
  mobileAgentLabel,
  mobilePane,
  mobileProjectTitle,
  mobileTitleVisible,
  onMobilePaneChange,
  onSidebarToggle,
  onSidebarToggleTopChange,
  onSidebarToggleTopCommit,
  sidebarCollapsed,
  sidebarToggleTop,
  summary
}: AppHeaderProps) {
  const [mobileControlsExpanded, setMobileControlsExpanded] = useState(false);
  const mobileControlsRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragMovedRef = useRef(false);
  const suppressLauncherClickRef = useRef(false);

  useEffect(() => {
    if (!mobileControlsExpanded) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (mobileControlsRef.current?.contains(event.target as Node | null)) {
        return;
      }
      setMobileControlsExpanded(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [mobileControlsExpanded]);

  useEffect(() => {
    if (!sidebarCollapsed) {
      setMobileControlsExpanded(false);
    }
  }, [sidebarCollapsed]);

  function handleLauncherPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startTop: sidebarToggleTop,
      startY: event.clientY
    };
    dragMovedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleLauncherPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaY = event.clientY - dragState.startY;
    if (Math.abs(deltaY) > 3) {
      dragMovedRef.current = true;
    }

    onSidebarToggleTopChange(clampSidebarToggleTop(dragState.startTop + deltaY, window.innerHeight));
  }

  function handleLauncherPointerEnd(event: ReactPointerEvent<HTMLButtonElement>): void {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const nextTop = clampSidebarToggleTop(dragState.startTop + (event.clientY - dragState.startY), window.innerHeight);
    onSidebarToggleTopChange(nextTop);
    onSidebarToggleTopCommit(nextTop);
    suppressLauncherClickRef.current = dragMovedRef.current;
    dragStateRef.current = null;
  }

  function handleLauncherPointerCancel(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (dragStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragStateRef.current = null;
    dragMovedRef.current = false;
  }

  function handleLauncherClick(): void {
    if (suppressLauncherClickRef.current) {
      suppressLauncherClickRef.current = false;
      return;
    }

    if (mobileControlsExpanded) {
      onSidebarToggle();
      setMobileControlsExpanded(false);
      return;
    }

    setMobileControlsExpanded(true);
  }

  function handleMobilePaneSelect(pane: WorkspacePane): void {
    onMobilePaneChange(pane);
    setMobileControlsExpanded(false);
  }

  return (
    <header className="sticky top-0 z-20 -mb-3 h-0 pointer-events-none lg:static lg:mb-0 lg:h-auto lg:pointer-events-auto">
      <div
        ref={mobileControlsRef}
        className="pointer-events-none fixed left-0 z-30 lg:hidden"
        style={{
          top: `calc(max(env(safe-area-inset-top), 0px) + ${sidebarToggleTop}px)`,
          left: 'max(env(safe-area-inset-left), 0.75rem)'
        }}
      >
        <div className="flex items-center gap-2">
          <div className="pointer-events-auto inline-flex max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-full border border-zinc-200/70 bg-white/82 p-1.5 shadow-[0_10px_28px_rgba(0,0,0,0.08)] backdrop-blur-md">
            <button
              type="button"
              onClick={handleLauncherClick}
              onPointerDown={handleLauncherPointerDown}
              onPointerMove={handleLauncherPointerMove}
              onPointerUp={handleLauncherPointerEnd}
              onPointerCancel={handleLauncherPointerCancel}
              className={[
                'flex h-10 w-10 items-center justify-center rounded-full transition',
                !sidebarCollapsed
                  ? 'bg-zinc-900 text-white shadow-[0_8px_24px_rgba(24,24,27,0.18)]'
                  : 'bg-white/78 text-zinc-500 shadow-[0_4px_14px_rgba(255,255,255,0.32)] hover:bg-white hover:text-zinc-900'
              ].join(' ')}
              aria-label={mobileControlsExpanded ? '打开边栏' : '展开移动控制条'}
              title={mobileControlsExpanded ? '打开边栏' : '展开移动控制条'}
              aria-pressed={mobileControlsExpanded}
            >
              <FloatingToggleIcon />
            </button>

            {mobileControlsExpanded ? (
              <>
                <div className="h-10 w-px bg-zinc-200/80" aria-hidden="true" />
                {(
                  [
                    ['chat', '切换到对话'],
                    ['terminal', '切换到终端']
                  ] as const satisfies ReadonlyArray<readonly [WorkspacePane, string]>
                ).map(([pane, label]) => (
                  <button
                    key={pane}
                    type="button"
                    onClick={() => handleMobilePaneSelect(pane)}
                    className={[
                      'flex h-10 w-10 items-center justify-center transition-transform duration-150 ease-out',
                      mobilePane === pane
                        ? 'scale-[1.16] text-sky-600'
                        : 'text-zinc-500 hover:scale-105 hover:text-zinc-900'
                    ].join(' ')}
                    aria-label={label}
                    title={label}
                    aria-pressed={mobilePane === pane}
                  >
                    <MobilePaneIcon pane={pane} />
                  </button>
                ))}
              </>
            ) : null}
            {mobileControlsExpanded ? (
              <>
                <div className="h-10 w-px bg-zinc-200/80" aria-hidden="true" />
                <div className="min-w-0 pr-2 pl-1">
                  <div className="truncate text-sm font-semibold text-zinc-950">{mobileProjectTitle}</div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-500">{mobileAgentLabel}</div>
                </div>
              </>
            ) : null}
          </div>
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
