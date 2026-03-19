import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';

import type { WorkspacePane } from '@/features/workspace/types.ts';
import { clampSidebarToggleTop } from '@/lib/workspace.ts';

interface MobileFloatingControlsProps {
  mobileAgentLabel: string;
  mobilePane: WorkspacePane;
  mobileProjectTitle: string;
  mobileSidebarOpen: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarOpen: () => void;
  onSidebarToggleTopChange: (value: SetStateAction<number>) => void;
  onSidebarToggleTopCommit: (value: number) => void;
  sidebarToggleTop: number;
}

interface DragState {
  pointerId: number;
  startTop: number;
  startY: number;
}

const LAUNCHER_DRAG_THRESHOLD = 10;

function FloatingToggleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
      <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.2 4.5v11M10.8 7.3l2.2 2.7-2.2 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
      <path d="M4 6h12M4 10h12M4 14h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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

export function MobileFloatingControls({
  mobileAgentLabel,
  mobilePane,
  mobileProjectTitle,
  mobileSidebarOpen,
  onMobilePaneChange,
  onSidebarOpen,
  onSidebarToggleTopChange,
  onSidebarToggleTopCommit,
  sidebarToggleTop
}: MobileFloatingControlsProps) {
  const [mobileControlsExpanded, setMobileControlsExpanded] = useState(false);
  const mobileControlsRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragMovedRef = useRef(false);

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
    if (mobileSidebarOpen) {
      setMobileControlsExpanded(false);
    }
  }, [mobileSidebarOpen]);

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
    if (!dragMovedRef.current && Math.abs(deltaY) <= LAUNCHER_DRAG_THRESHOLD) {
      return;
    }

    if (Math.abs(deltaY) > LAUNCHER_DRAG_THRESHOLD) {
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

    const deltaY = event.clientY - dragState.startY;

    if (dragMovedRef.current || Math.abs(deltaY) > LAUNCHER_DRAG_THRESHOLD) {
      const nextTop = clampSidebarToggleTop(dragState.startTop + deltaY, window.innerHeight);
      onSidebarToggleTopChange(nextTop);
      onSidebarToggleTopCommit(nextTop);
    } else {
      handleLauncherAction();
    }

    dragStateRef.current = null;
    dragMovedRef.current = false;
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

  function handleLauncherAction(): void {
    if (mobileControlsExpanded) {
      onSidebarOpen();
      setMobileControlsExpanded(false);
      return;
    }

    setMobileControlsExpanded(true);
  }

  function handleLauncherKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    handleLauncherAction();
  }

  function handleMobilePaneSelect(pane: WorkspacePane): void {
    onMobilePaneChange(pane);
    setMobileControlsExpanded(false);
  }

  return (
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
            onPointerDown={handleLauncherPointerDown}
            onPointerMove={handleLauncherPointerMove}
            onPointerUp={handleLauncherPointerEnd}
            onPointerCancel={handleLauncherPointerCancel}
            onKeyDown={handleLauncherKeyDown}
            className="touch-none select-none flex h-10 w-10 items-center justify-center rounded-full bg-white/78 text-zinc-500 shadow-[0_4px_14px_rgba(255,255,255,0.32)] transition hover:bg-white hover:text-zinc-900"
            aria-label={mobileControlsExpanded ? '打开边栏' : '展开移动控制条'}
            title={mobileControlsExpanded ? '打开边栏' : '展开移动控制条'}
            aria-pressed={mobileControlsExpanded}
          >
            {mobileControlsExpanded ? <MenuIcon /> : <FloatingToggleIcon />}
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
  );
}
