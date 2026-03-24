import { useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';

import type { MobileJumpControls, WorkspacePane } from '@/features/workspace/types.ts';

interface MobileFloatingControlsProps {
  composerDockHeight: number;
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

function MenuLauncherIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6 6h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M6 10h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M6 14h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="4.25" cy="6" r="1" fill="currentColor" />
      <circle cx="4.25" cy="10" r="1" fill="currentColor" />
      <circle cx="4.25" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

function PrevQuestionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="m11.75 5.5-4.5 4.5 4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NextQuestionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="m8.25 5.5 4.5 4.5-4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function JumpToTopIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M5 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m6.25 12.25 3.75-3.75 3.75 3.75" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function JumpToBottomIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M5 14h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m6.25 7.75 3.75 3.75 3.75-3.75" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ConversationListIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6 6h8M6 10h8M6 14h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="4.25" cy="6" r="1" fill="currentColor" />
      <circle cx="4.25" cy="10" r="1" fill="currentColor" />
      <circle cx="4.25" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

function PaneSwitchIcon({ targetPane }: { targetPane: WorkspacePane }) {
  if (targetPane === 'terminal') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
        <rect x="3.5" y="4.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.8 8.1 8.9 10l-2.1 1.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.7 11.9h2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path
        d="M4.5 6.5A2.5 2.5 0 0 1 7 4h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 13 12H9.8l-2.9 2.5c-.7.6-1.7.1-1.7-.8V12A2.5 2.5 0 0 1 4.5 9.5v-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActionButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-8 w-8 items-center justify-center rounded-full border transition',
        active
          ? 'border-sky-200 bg-sky-50 text-sky-700 shadow-[0_8px_20px_rgba(14,165,233,0.14)]'
          : 'border-zinc-200/80 bg-white/94 text-zinc-700 shadow-[0_8px_20px_rgba(15,23,42,0.10)] backdrop-blur-md',
        disabled ? 'cursor-not-allowed text-zinc-300 opacity-70 shadow-none' : 'hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950'
      ].join(' ')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function MobileFloatingControls({
  composerDockHeight,
  jumpControls,
  mobileAgentLabel: _mobileAgentLabel,
  mobilePane,
  mobileProjectTitle,
  mobileSidebarOpen,
  onMobilePaneChange,
  onSidebarOpen,
  onSidebarToggleTopChange: _onSidebarToggleTopChange,
  onSidebarToggleTopCommit: _onSidebarToggleTopCommit,
  sidebarToggleTop: _sidebarToggleTop
}: MobileFloatingControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const targetPane: WorkspacePane = mobilePane === 'chat' ? 'terminal' : 'chat';
  const isTerminalPane = mobilePane === 'terminal';
  const canJumpUp = jumpControls?.canJumpUp ?? false;
  const canJumpDown = jumpControls?.canJumpDown ?? false;

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (controlsRef.current?.contains(event.target as Node | null)) {
        return;
      }
      setExpanded(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (mobileSidebarOpen) {
      setExpanded(false);
    }
  }, [mobileSidebarOpen]);

  function handlePaneSwitch(): void {
    onMobilePaneChange(targetPane);
    setExpanded(false);
  }

  function handleConversationListOpen(): void {
    onSidebarOpen();
    setExpanded(false);
  }

  function handleJumpUp(): void {
    jumpControls?.onJumpUp();
    setExpanded(false);
  }

  function handleJumpDown(): void {
    jumpControls?.onJumpDown();
    setExpanded(false);
  }

  return (
    <div
      ref={controlsRef}
      className="pointer-events-none fixed right-0 bottom-0 z-30 lg:hidden"
      style={{
        right: 'max(env(safe-area-inset-right), 0.75rem)',
        bottom: `calc(max(env(safe-area-inset-bottom), 0px) + ${composerDockHeight}px + 0.75rem)`
      }}
    >
      <div className="pointer-events-auto flex items-center justify-end">
        <div
          className={[
            'inline-flex items-center overflow-hidden rounded-full transition-[max-width,padding,background-color,border-color,box-shadow] duration-200 ease-out',
            expanded
              ? 'max-w-[calc(100vw-1.5rem)] gap-1 border border-zinc-200/80 bg-white/92 px-1.5 py-1 shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur-xl'
              : 'max-w-[2.5rem] bg-transparent p-0 shadow-none'
          ].join(' ')}
        >
          {expanded ? (
            <>
            <div
              className="flex h-10 max-w-[6.25rem] shrink-0 flex-col items-start justify-center rounded-2xl bg-zinc-100 px-2.5 text-left"
              title={mobileProjectTitle}
              aria-label={`当前项目 ${mobileProjectTitle}，Provider ${_mobileAgentLabel}`}
            >
              <span className="w-full truncate text-[11px] font-semibold leading-none text-zinc-700">{mobileProjectTitle}</span>
              <span
                className={[
                  'mt-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none',
                  _mobileAgentLabel === 'claude'
                    ? 'bg-orange-100 text-orange-700'
                    : _mobileAgentLabel === 'codex'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-zinc-200 text-zinc-600'
                ].join(' ')}
              >
                {_mobileAgentLabel}
              </span>
            </div>

            <ActionButton disabled={!canJumpUp} label={jumpControls?.upLabel ?? '上一问'} onClick={handleJumpUp}>
              {isTerminalPane ? <JumpToTopIcon /> : <PrevQuestionIcon />}
            </ActionButton>

            <ActionButton disabled={!canJumpDown} label={jumpControls?.downLabel ?? '下一问'} onClick={handleJumpDown}>
              {isTerminalPane ? <JumpToBottomIcon /> : <NextQuestionIcon />}
            </ActionButton>

            <ActionButton
              active
              label={targetPane === 'terminal' ? '切到终端' : '切到会话'}
              onClick={handlePaneSwitch}
            >
              <PaneSwitchIcon targetPane={targetPane} />
            </ActionButton>

            <ActionButton label="会话列表" onClick={handleConversationListOpen}>
              <ConversationListIcon />
            </ActionButton>
            </>
          ) : null}

          {!expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-200/80 bg-white text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950"
              aria-label="展开快捷操作"
              title="展开快捷操作"
              aria-pressed={false}
            >
              <MenuLauncherIcon />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
