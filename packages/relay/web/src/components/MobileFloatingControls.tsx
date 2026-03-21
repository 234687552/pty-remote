import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';

import type { MobileJumpControls, WorkspacePane } from '@/features/workspace/types.ts';
import { clampSidebarToggleTop } from '@/lib/workspace.ts';

interface MobileFloatingControlsProps {
  jumpControls: MobileJumpControls | null;
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

const JUMP_LONG_PRESS_DELAY_MS = 420;
const LAUNCHER_LONG_PRESS_DELAY_MS = 320;
const PANE_BUTTONS = [
  ['chat', '切换到对话'],
  ['terminal', '切换到终端']
] as const satisfies ReadonlyArray<readonly [WorkspacePane, string]>;

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

function SidebarOpenIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
      <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.2 4.5v11M10.8 7.3l2.2 2.7-2.2 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
      {direction === 'up' ? (
        <path d="M5 12l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
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
  jumpControls,
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
  const jumpPressTimeoutRef = useRef<number | null>(null);
  const jumpLongPressTriggeredRef = useRef(false);
  const launcherPressTimeoutRef = useRef<number | null>(null);
  const launcherLongPressTriggeredRef = useRef(false);

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

  useEffect(() => {
    return () => {
      if (jumpPressTimeoutRef.current !== null) {
        window.clearTimeout(jumpPressTimeoutRef.current);
      }
      if (launcherPressTimeoutRef.current !== null) {
        window.clearTimeout(launcherPressTimeoutRef.current);
      }
    };
  }, []);

  function clearJumpPressTimeout(): void {
    if (jumpPressTimeoutRef.current !== null) {
      window.clearTimeout(jumpPressTimeoutRef.current);
      jumpPressTimeoutRef.current = null;
    }
  }

  function clearLauncherPressTimeout(): void {
    if (launcherPressTimeoutRef.current !== null) {
      window.clearTimeout(launcherPressTimeoutRef.current);
      launcherPressTimeoutRef.current = null;
    }
  }

  function handleLauncherToggle(): void {
    setMobileControlsExpanded((current) => !current);
  }

  function handleLauncherPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    clearLauncherPressTimeout();
    launcherLongPressTriggeredRef.current = false;
    dragStateRef.current = {
      pointerId: event.pointerId,
      startTop: sidebarToggleTop,
      startY: event.clientY
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    launcherPressTimeoutRef.current = window.setTimeout(() => {
      launcherPressTimeoutRef.current = null;
      launcherLongPressTriggeredRef.current = true;
    }, LAUNCHER_LONG_PRESS_DELAY_MS);
  }

  function handleLauncherPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || !launcherLongPressTriggeredRef.current) {
      return;
    }

    const deltaY = event.clientY - dragState.startY;
    onSidebarToggleTopChange(clampSidebarToggleTop(dragState.startTop + deltaY, window.innerHeight));
  }

  function handleLauncherPointerEnd(event: ReactPointerEvent<HTMLButtonElement>): void {
    const dragState = dragStateRef.current;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
    clearLauncherPressTimeout();

    if (launcherLongPressTriggeredRef.current && dragState) {
      const deltaY = event.clientY - dragState.startY;
      const nextTop = clampSidebarToggleTop(dragState.startTop + deltaY, window.innerHeight);
      onSidebarToggleTopChange(nextTop);
      onSidebarToggleTopCommit(nextTop);
      launcherLongPressTriggeredRef.current = false;
      return;
    }

    if (launcherLongPressTriggeredRef.current) {
      launcherLongPressTriggeredRef.current = false;
      return;
    }

    handleLauncherToggle();
  }

  function handleLauncherPointerCancel(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
    clearLauncherPressTimeout();
    launcherLongPressTriggeredRef.current = false;
  }

  function handleLauncherKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    handleLauncherToggle();
  }

  function handleJumpPressStart(direction: 'up' | 'down', event: ReactPointerEvent<HTMLButtonElement>): void {
    const onLongPress = direction === 'up' ? jumpControls?.onJumpUpLongPress : jumpControls?.onJumpDownLongPress;
    const canJump = direction === 'up' ? jumpControls?.canJumpUp : jumpControls?.canJumpDown;
    if (!canJump) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    clearJumpPressTimeout();
    jumpLongPressTriggeredRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (!onLongPress) {
      return;
    }

    jumpPressTimeoutRef.current = window.setTimeout(() => {
      jumpPressTimeoutRef.current = null;
      jumpLongPressTriggeredRef.current = true;
      onLongPress();
    }, JUMP_LONG_PRESS_DELAY_MS);
  }

  function handleJumpPressEnd(direction: 'up' | 'down', event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    clearJumpPressTimeout();

    if (jumpLongPressTriggeredRef.current) {
      jumpLongPressTriggeredRef.current = false;
      return;
    }

    if (direction === 'up') {
      jumpControls?.onJumpUp();
      return;
    }

    jumpControls?.onJumpDown();
  }

  function handleJumpPressCancel(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    clearJumpPressTimeout();
    jumpLongPressTriggeredRef.current = false;
  }

  function handleJumpKeyboardClick(direction: 'up' | 'down', event: React.MouseEvent<HTMLButtonElement>): void {
    if (event.detail !== 0) {
      return;
    }

    if (direction === 'up') {
      jumpControls?.onJumpUp();
      return;
    }

    jumpControls?.onJumpDown();
  }

  function handleMobilePaneSelect(pane: WorkspacePane): void {
    onMobilePaneChange(pane);
    setMobileControlsExpanded(false);
  }

  function handleSidebarOpenClick(): void {
    setMobileControlsExpanded(false);
    onSidebarOpen();
  }

  const canJumpUp = jumpControls?.canJumpUp ?? false;
  const canJumpDown = jumpControls?.canJumpDown ?? false;

  return (
    <div
      ref={mobileControlsRef}
      className="pointer-events-none fixed right-0 z-30 lg:hidden"
      style={{
        top: `calc(max(env(safe-area-inset-top), 0px) + ${sidebarToggleTop}px)`,
        right: 'max(env(safe-area-inset-right), 0.75rem)'
      }}
    >
      <div className="relative flex h-12 w-12 items-center justify-center">
        {mobileControlsExpanded ? (
          <>
            <button
              type="button"
              onClick={(event) => handleJumpKeyboardClick('up', event)}
              onPointerDown={(event) => handleJumpPressStart('up', event)}
              onPointerUp={(event) => handleJumpPressEnd('up', event)}
              onPointerCancel={handleJumpPressCancel}
              disabled={!canJumpUp}
              className={[
                'pointer-events-auto absolute bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200/80 bg-white/88 shadow-[0_10px_24px_rgba(15,23,42,0.12)] backdrop-blur-md transition',
                canJumpUp
                  ? 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                  : 'cursor-not-allowed text-zinc-300'
              ].join(' ')}
              aria-label={jumpControls?.upLabel ?? '向上跳转'}
              title={jumpControls?.upLabel ?? '向上跳转'}
            >
              <ArrowIcon direction="up" />
            </button>

            <div
              className="pointer-events-none absolute top-1/2 right-[calc(100%+0.65rem)] -translate-y-1/2 transition-all duration-200"
            >
              <div className="pointer-events-auto inline-flex max-w-[calc(100vw-5.75rem)] items-center gap-1 rounded-full border border-zinc-200/80 bg-white/88 px-2 py-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.14)] backdrop-blur-md">
                <div className="min-w-0 max-w-[9.5rem] pr-1">
                  <div className="truncate text-sm font-semibold text-zinc-950">{mobileProjectTitle}</div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-500">{mobileAgentLabel}</div>
                </div>

                <div className="mx-1 h-10 w-px shrink-0 bg-zinc-200/80" aria-hidden="true" />

                {[...PANE_BUTTONS].reverse().map(([pane, label]) => (
                  <button
                    key={pane}
                    type="button"
                    onClick={() => handleMobilePaneSelect(pane)}
                    className={[
                      'flex h-10 w-10 items-center justify-center rounded-full transition-transform duration-150 ease-out',
                      mobilePane === pane
                        ? 'scale-[1.12] bg-sky-50 text-sky-600'
                        : 'text-zinc-500 hover:scale-105 hover:bg-zinc-100 hover:text-zinc-900'
                    ].join(' ')}
                    aria-label={label}
                    title={label}
                    aria-pressed={mobilePane === pane}
                  >
                    <MobilePaneIcon pane={pane} />
                  </button>
                ))}

                <div className="mx-1 h-10 w-px shrink-0 bg-zinc-200/80" aria-hidden="true" />

                <button
                  type="button"
                  onClick={handleSidebarOpenClick}
                  className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-500 transition hover:scale-105 hover:bg-zinc-100 hover:text-zinc-900"
                  aria-label="打开侧边栏"
                  title="打开侧边栏"
                >
                  <SidebarOpenIcon />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={(event) => handleJumpKeyboardClick('down', event)}
              onPointerDown={(event) => handleJumpPressStart('down', event)}
              onPointerUp={(event) => handleJumpPressEnd('down', event)}
              onPointerCancel={handleJumpPressCancel}
              disabled={!canJumpDown}
              className={[
                'pointer-events-auto absolute top-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200/80 bg-white/88 shadow-[0_10px_24px_rgba(15,23,42,0.12)] backdrop-blur-md transition',
                canJumpDown
                  ? 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                  : 'cursor-not-allowed text-zinc-300'
              ].join(' ')}
              aria-label={jumpControls?.downLabel ?? '向下跳转'}
              title={jumpControls?.downLabel ?? '向下跳转'}
            >
              <ArrowIcon direction="down" />
            </button>
          </>
        ) : null}

        <button
          type="button"
          onPointerDown={handleLauncherPointerDown}
          onPointerMove={handleLauncherPointerMove}
          onPointerUp={handleLauncherPointerEnd}
          onPointerCancel={handleLauncherPointerCancel}
          onKeyDown={handleLauncherKeyDown}
          className="pointer-events-auto touch-none select-none flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200/80 bg-white/88 text-zinc-600 shadow-[0_10px_24px_rgba(15,23,42,0.12)] backdrop-blur-md transition hover:bg-zinc-100 hover:text-zinc-900"
          aria-label={mobileControlsExpanded ? '收起快捷操作，长按拖动' : '展开快捷操作，长按拖动'}
          title={mobileControlsExpanded ? '收起快捷操作，长按拖动' : '展开快捷操作，长按拖动'}
          aria-pressed={mobileControlsExpanded}
        >
          {mobileControlsExpanded ? <MenuIcon /> : <FloatingToggleIcon />}
        </button>
      </div>
    </div>
  );
}
