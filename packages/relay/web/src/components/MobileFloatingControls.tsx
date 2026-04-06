import { useEffect, useRef, useState } from 'react';

import type { MobileJumpControls, WorkspacePane } from '@/features/workspace/types.ts';
import { TerminalQuickKeys } from '@/components/TerminalQuickKeys.tsx';

interface MobileStatusBadge {
  className: string;
  label: string;
  value: string;
}

interface MobileFloatingControlsProps {
  canOpenFiles: boolean;
  canSendTerminalInput: boolean;
  jumpControls: MobileJumpControls | null;
  mobileAgentLabel: string;
  mobilePane: WorkspacePane;
  mobileProjectTitle: string;
  mobileSidebarOpen: boolean;
  statusBadges: MobileStatusBadge[];
  terminalSupported: boolean;
  onFilesOpen: () => void;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarOpen: () => void;
  onTerminalInput: (input: string) => void;
}

const MOBILE_FLOATING_CONTROLS_OFFSET_STORAGE_KEY = 'pty-remote.mobile-floating-controls.offset-y';
const MOBILE_FLOATING_CONTROLS_MIN_OFFSET_PX = -220;
const MOBILE_FLOATING_CONTROLS_MAX_OFFSET_PX = 24;
const MOBILE_FLOATING_CONTROLS_DRAG_THRESHOLD_PX = 6;

function ExpandControlsIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={['h-3.5 w-3.5 transition-transform duration-200', expanded ? 'rotate-180' : 'rotate-0'].join(' ')}
    >
      <path d="m5.5 12.5 4.5-5 4.5 5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
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

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <rect x="3.25" y="5" width="13.5" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.75 8.2h.01M8.35 8.2h.01M10.95 8.2h.01M13.55 8.2h.01M5.75 10.8h.01M8.35 10.8h.01M10.95 10.8h.01M13.55 10.8h.01M7 13.1h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6.15 3.75h5.45L15 7.15v8.1a1 1 0 0 1-1 1H6.15a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M11.6 3.75V7.1H15" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M7.75 10.1h4.55M7.75 12.9h4.55" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function StatusTextBadge({
  className,
  label,
  value
}: {
  className: string;
  label: string;
  value: string;
}) {
  const compactLabel = label === 'status' ? '状态' : label === 'socket' ? '连线' : label === 'cli' ? 'CLI' : label;
  const compactValue =
    value === 'online'
      ? '在线'
      : value === 'offline'
        ? '离线'
        : value === 'unselected'
          ? '未选'
          : value === 'running'
            ? '执行中'
            : value === 'starting'
              ? '启动中'
              : value === 'idle'
                ? '空闲'
                : value === 'timeout'
                  ? '超时'
                  : value === 'error'
                    ? '异常'
                    : value;
  const toneClass = resolveStatusTextTone(className);
  const showBusyDots = label === 'status' && (value === 'running' || value === 'starting');

  return (
    <span
      className={[
        'inline-flex h-5 max-w-[4.6rem] min-w-0 shrink-0 items-center px-1 text-[9px] font-semibold leading-[1]',
        toneClass
      ].join(' ')}
      title={`${compactLabel}: ${compactValue}`}
      aria-label={`${compactLabel}: ${compactValue}`}
    >
      <span className="truncate">{compactLabel}</span>
      <span className="mx-0.5 opacity-40">·</span>
      {showBusyDots ? (
        <span className="inline-flex items-center gap-0.5" aria-hidden="true">
          <span className="typing-dot typing-dot-delay-0 inline-block h-1 w-1 rounded-full bg-current" />
          <span className="typing-dot typing-dot-delay-1 inline-block h-1 w-1 rounded-full bg-current" />
          <span className="typing-dot typing-dot-delay-2 inline-block h-1 w-1 rounded-full bg-current" />
        </span>
      ) : (
        <span className="truncate">{compactValue}</span>
      )}
    </span>
  );
}

function resolveStatusTextTone(className: string): string {
  if (className.includes('text-red-')) {
    return 'text-red-700';
  }
  if (className.includes('text-emerald-')) {
    return 'text-emerald-700';
  }
  if (className.includes('text-amber-')) {
    return 'text-amber-700';
  }
  if (className.includes('text-white')) {
    return 'text-zinc-900';
  }
  if (className.includes('text-zinc-600')) {
    return 'text-zinc-600';
  }
  return 'text-zinc-700';
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
  canOpenFiles,
  canSendTerminalInput,
  jumpControls,
  mobileAgentLabel: _mobileAgentLabel,
  mobilePane,
  mobileProjectTitle,
  mobileSidebarOpen,
  statusBadges,
  terminalSupported,
  onFilesOpen,
  onMobilePaneChange,
  onSidebarOpen,
  onTerminalInput
}: MobileFloatingControlsProps) {
  const [openPanel, setOpenPanel] = useState<'none' | 'actions' | 'keyboard'>('none');
  const [floatingOffsetY, setFloatingOffsetY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    dragging: boolean;
    pointerId: number;
    startOffsetY: number;
    startY: number;
  } | null>(null);
  const suppressToggleClickRef = useRef(false);
  const targetPane: WorkspacePane = mobilePane === 'chat' ? 'terminal' : 'chat';
  const isTerminalPane = mobilePane === 'terminal';
  const canJumpUp = jumpControls?.canJumpUp ?? false;
  const canJumpDown = jumpControls?.canJumpDown ?? false;
  const actionsExpanded = openPanel === 'actions';
  const keyboardExpanded = openPanel === 'keyboard';

  useEffect(() => {
    if (openPanel === 'none') {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (controlsRef.current?.contains(event.target as Node | null)) {
        return;
      }
      setOpenPanel('none');
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [openPanel]);

  useEffect(() => {
    if (mobileSidebarOpen) {
      setOpenPanel('none');
    }
  }, [mobileSidebarOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const savedOffset = Number(window.localStorage.getItem(MOBILE_FLOATING_CONTROLS_OFFSET_STORAGE_KEY) ?? '0');
    if (Number.isFinite(savedOffset)) {
      setFloatingOffsetY(clampFloatingOffsetY(savedOffset));
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(MOBILE_FLOATING_CONTROLS_OFFSET_STORAGE_KEY, String(floatingOffsetY));
  }, [floatingOffsetY]);

  useEffect(() => {
    if (!isTerminalPane && openPanel === 'keyboard') {
      setOpenPanel('none');
    }
  }, [isTerminalPane, openPanel]);

  function handlePaneSwitch(): void {
    if (!terminalSupported) {
      return;
    }
    onMobilePaneChange(targetPane);
    setOpenPanel('none');
  }

  function handleConversationListOpen(): void {
    onSidebarOpen();
    setOpenPanel('none');
  }

  function handleFilesOpen(): void {
    onFilesOpen();
    setOpenPanel('none');
  }

  function handleJumpUp(): void {
    jumpControls?.onJumpUp();
    setOpenPanel('none');
  }

  function handleJumpDown(): void {
    jumpControls?.onJumpDown();
    setOpenPanel('none');
  }

  function handleExpandedToggle(): void {
    setOpenPanel((current) => (current === 'actions' ? 'none' : 'actions'));
  }

  function handleKeyboardToggle(): void {
    setOpenPanel((current) => (current === 'keyboard' ? 'none' : 'keyboard'));
  }

  function clampFloatingOffsetY(offset: number): number {
    return Math.max(MOBILE_FLOATING_CONTROLS_MIN_OFFSET_PX, Math.min(MOBILE_FLOATING_CONTROLS_MAX_OFFSET_PX, Math.round(offset)));
  }

  function handleDragStart(event: React.PointerEvent<HTMLButtonElement>): void {
    dragStateRef.current = {
      dragging: false,
      pointerId: event.pointerId,
      startOffsetY: floatingOffsetY,
      startY: event.clientY
    };
    suppressToggleClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleDragMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }

    const deltaY = event.clientY - current.startY;
    if (!current.dragging && Math.abs(deltaY) < MOBILE_FLOATING_CONTROLS_DRAG_THRESHOLD_PX) {
      return;
    }

    if (!current.dragging) {
      current.dragging = true;
      setDragging(true);
    }

    setFloatingOffsetY(clampFloatingOffsetY(current.startOffsetY + deltaY));
    event.preventDefault();
  }

  function finishDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    suppressToggleClickRef.current = current.dragging;
    dragStateRef.current = null;
    if (dragging) {
      setDragging(false);
      event.preventDefault();
    }
  }

  return (
    <div
      ref={controlsRef}
      className={[
        'relative flex w-full items-center justify-center lg:hidden',
        dragging ? '' : 'transition-transform duration-200 ease-out'
      ].join(' ')}
      style={{
        transform: `translateY(${floatingOffsetY}px)`
      }}
    >
      {actionsExpanded ? (
        <div className="absolute bottom-full left-1/2 z-30 mb-0.5 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto px-1 py-0.5">
          <div
            className="flex h-9 max-w-[6rem] shrink-0 flex-col items-start justify-center rounded-full bg-zinc-100 px-3 text-left shadow-[0_8px_18px_rgba(15,23,42,0.08)]"
            title={mobileProjectTitle}
            aria-label={`当前项目 ${mobileProjectTitle}，Provider ${_mobileAgentLabel}`}
          >
            <span className="w-full truncate text-[10px] font-semibold leading-none text-zinc-700">{mobileProjectTitle}</span>
            <span
              className={[
                'mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[8px] font-semibold leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]',
                _mobileAgentLabel.toLowerCase() === 'claude'
                  ? 'bg-orange-100 text-orange-700'
                  : _mobileAgentLabel.toLowerCase() === 'codex'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-zinc-200 text-zinc-600'
              ].join(' ')}
            >
              {_mobileAgentLabel}
            </span>
          </div>

          <ActionButton label="会话列表" onClick={handleConversationListOpen}>
            <ConversationListIcon />
          </ActionButton>

          <ActionButton disabled={!canJumpUp} label={jumpControls?.upLabel ?? '上一问'} onClick={handleJumpUp}>
            {isTerminalPane ? <JumpToTopIcon /> : <PrevQuestionIcon />}
          </ActionButton>

          <ActionButton disabled={!canJumpDown} label={jumpControls?.downLabel ?? '下一问'} onClick={handleJumpDown}>
            {isTerminalPane ? <JumpToBottomIcon /> : <NextQuestionIcon />}
          </ActionButton>

          {terminalSupported ? (
            <ActionButton
              active
              label={targetPane === 'terminal' ? '切到终端' : '切到会话'}
              onClick={handlePaneSwitch}
            >
              <PaneSwitchIcon targetPane={targetPane} />
            </ActionButton>
          ) : null}

          <ActionButton disabled={!canOpenFiles} label="文件浏览" onClick={handleFilesOpen}>
            <FilesIcon />
          </ActionButton>
        </div>
      ) : null}

      {isTerminalPane && keyboardExpanded ? (
        <div className="absolute bottom-full left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto px-1 py-0.5">
          <TerminalQuickKeys variant="mobile-action" disabled={!canSendTerminalInput} onInput={onTerminalInput} />
        </div>
      ) : null}

      <div className="relative h-6 w-full transition">
        <div className="absolute inset-y-0 left-0 flex min-w-0 max-w-[calc(50%-2.6rem)] items-center gap-1 overflow-hidden">
          {statusBadges
            .filter((badge) => badge.label === 'status' || ((badge.label === 'socket' || badge.label === 'cli') && badge.value === 'offline'))
            .map((badge) => (
              <StatusTextBadge key={badge.label} className={badge.className} label={badge.label} value={badge.value} />
            ))}
        </div>

        <div className="absolute top-0 left-1/2 flex -translate-x-1/2 items-center">
          <button
            type="button"
            onClick={() => {
              if (suppressToggleClickRef.current) {
                suppressToggleClickRef.current = false;
                return;
              }
              handleExpandedToggle();
            }}
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            className={[
              'flex h-6 w-10 items-center justify-center text-zinc-700 transition',
              actionsExpanded
                ? 'text-sky-700'
                : 'hover:text-zinc-950'
            ].join(' ')}
            aria-label={actionsExpanded ? '收起快捷操作' : '展开快捷操作'}
            title={actionsExpanded ? '收起快捷操作' : '展开快捷操作'}
            aria-expanded={actionsExpanded}
          >
            <span className="pointer-events-none flex items-center gap-1">
              <span className="h-px w-3 rounded-full bg-current/65" />
              <ExpandControlsIcon expanded={actionsExpanded} />
              <span className="h-px w-3 rounded-full bg-current/65" />
            </span>
          </button>

          {isTerminalPane ? (
            <button
              type="button"
              onClick={handleKeyboardToggle}
              disabled={!canSendTerminalInput}
              className={[
                'ml-1 flex h-6 w-6 items-center justify-center text-zinc-700 transition',
                keyboardExpanded ? 'text-sky-700' : 'hover:text-zinc-950',
                !canSendTerminalInput ? 'cursor-not-allowed opacity-40' : ''
              ].join(' ')}
              aria-label={keyboardExpanded ? '收起终端按键' : '展开终端按键'}
              title={keyboardExpanded ? '收起终端按键' : '展开终端按键'}
              aria-pressed={keyboardExpanded}
            >
              <KeyboardIcon />
            </button>
          ) : null}
        </div>

      </div>
    </div>
  );
}
