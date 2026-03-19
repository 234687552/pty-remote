import { useContext, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

import { decodeTerminalFrameStyle, resolveTerminalFrameColor, type TerminalFrameLine, type TerminalFrameSnapshot } from '@lzdi/pty-remote-protocol/terminal-frame.ts';

import { MobileHeaderVisibilityContext } from '@/app-shell/AppShell.tsx';

interface TerminalPaneProps {
  frameSnapshot: TerminalFrameSnapshot | null;
  hostRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  onJumpToEdge: (direction: 'up' | 'down') => void;
}

const STYLE_FLAG_BOLD = 1 << 0;
const STYLE_FLAG_ITALIC = 1 << 1;
const STYLE_FLAG_DIM = 1 << 2;
const STYLE_FLAG_UNDERLINE = 1 << 3;
const STYLE_FLAG_INVERSE = 1 << 5;
const STYLE_FLAG_INVISIBLE = 1 << 6;
const STYLE_FLAG_STRIKETHROUGH = 1 << 7;
const STYLE_FLAG_OVERLINE = 1 << 8;
const TERMINAL_FOREGROUND = '#111827';
const TERMINAL_BACKGROUND = '#ffffff';
const TERMINAL_CURSOR_BACKGROUND = '#111827';
const TERMINAL_CURSOR_FOREGROUND = '#ffffff';
const TERMINAL_MEASURE_TEXT = 'MMMMMMMMMM';

function resolveRunStyle(styleToken: string): CSSProperties {
  const decodedStyle = decodeTerminalFrameStyle(styleToken);
  let foreground = resolveTerminalFrameColor(decodedStyle.fgMode, decodedStyle.fg, TERMINAL_FOREGROUND);
  let background = resolveTerminalFrameColor(decodedStyle.bgMode, decodedStyle.bg, 'transparent');

  if (decodedStyle.flags & STYLE_FLAG_INVERSE) {
    const resolvedBackground = background === 'transparent' ? TERMINAL_BACKGROUND : background;
    background = foreground;
    foreground = resolvedBackground;
  }

  const textDecoration: string[] = [];
  if (decodedStyle.flags & STYLE_FLAG_UNDERLINE) {
    textDecoration.push('underline');
  }
  if (decodedStyle.flags & STYLE_FLAG_STRIKETHROUGH) {
    textDecoration.push('line-through');
  }
  if (decodedStyle.flags & STYLE_FLAG_OVERLINE) {
    textDecoration.push('overline');
  }

  return {
    backgroundColor: background,
    color: decodedStyle.flags & STYLE_FLAG_INVISIBLE ? 'transparent' : foreground,
    fontStyle: decodedStyle.flags & STYLE_FLAG_ITALIC ? 'italic' : 'normal',
    fontWeight: decodedStyle.flags & STYLE_FLAG_BOLD ? 700 : 400,
    opacity: decodedStyle.flags & STYLE_FLAG_DIM ? 0.72 : 1,
    textDecoration: textDecoration.join(' ') || 'none'
  };
}

function lineToText(line: TerminalFrameLine): string {
  return line.runs.map((run) => run.text).join('');
}

function renderCursorLine(line: TerminalFrameLine | undefined, cursorColumn: number): ReactNode {
  const lineText = line ? lineToText(line) : '';
  const boundedCursor = Math.max(0, cursorColumn);
  const prefix = lineText.slice(0, Math.min(lineText.length, boundedCursor));
  const suffixStart = Math.min(lineText.length, boundedCursor + 1);
  const cursorText = boundedCursor < lineText.length ? lineText[boundedCursor] : ' ';
  const suffix = suffixStart <= lineText.length ? lineText.slice(suffixStart) : '';

  return (
    <>
      {prefix}
      <span
        className="terminal-frame-cursor"
        style={{
          backgroundColor: TERMINAL_CURSOR_BACKGROUND,
          color: TERMINAL_CURSOR_FOREGROUND
        }}
      >
        {cursorText}
      </span>
      {suffix}
    </>
  );
}

export function TerminalPane({ frameSnapshot, hostRef, viewportRef, visible, onJumpToEdge }: TerminalPaneProps) {
  const setMobileHeaderVisible = useContext(MobileHeaderVisibilityContext);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const pointerStartYRef = useRef<number | null>(null);

  const cursorBufferLineIndex = useMemo(() => {
    if (!frameSnapshot) {
      return null;
    }
    return Math.max(
      0,
      Math.min(frameSnapshot.lines.length - 1, frameSnapshot.baseY + frameSnapshot.cursorY - frameSnapshot.tailStart)
    );
  }, [frameSnapshot]);

  function handleVerticalGesture(deltaY: number): void {
    if (deltaY > 14) {
      setMobileHeaderVisible(true);
    } else if (deltaY < -8) {
      setMobileHeaderVisible(false);
    }
  }

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !visible) {
      return;
    }

    const isEventInsideRoot = (target: EventTarget | null): target is Node => target instanceof Node && root.contains(target);

    const handleTouchStart = (event: TouchEvent) => {
      if (!isEventInsideRoot(event.target)) {
        return;
      }

      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!isEventInsideRoot(event.target)) {
        return;
      }

      const touchStartY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (touchStartY == null || currentY == null) {
        return;
      }

      handleVerticalGesture(currentY - touchStartY);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!isEventInsideRoot(event.target)) {
        return;
      }

      touchStartYRef.current = null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !isEventInsideRoot(event.target)) {
        return;
      }

      pointerStartYRef.current = event.clientY;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !isEventInsideRoot(event.target)) {
        return;
      }

      const pointerStartY = pointerStartYRef.current;
      if (pointerStartY == null) {
        return;
      }

      handleVerticalGesture(event.clientY - pointerStartY);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !isEventInsideRoot(event.target)) {
        return;
      }

      pointerStartYRef.current = null;
    };

    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });
    document.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', handleTouchEnd, { capture: true, passive: true });
    document.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
    document.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
    document.addEventListener('pointerup', handlePointerEnd, { capture: true, passive: true });
    document.addEventListener('pointercancel', handlePointerEnd, { capture: true, passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart, true);
      document.removeEventListener('touchmove', handleTouchMove, true);
      document.removeEventListener('touchend', handleTouchEnd, true);
      document.removeEventListener('touchcancel', handleTouchEnd, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointermove', handlePointerMove, true);
      document.removeEventListener('pointerup', handlePointerEnd, true);
      document.removeEventListener('pointercancel', handlePointerEnd, true);
    };
  }, [setMobileHeaderVisible, visible]);

  return (
    <div
      ref={rootRef}
      className={[
        'relative flex min-h-[22rem] min-w-0 flex-1 flex-col overflow-hidden bg-transparent sm:min-h-[24rem] lg:min-h-[28rem] lg:rounded-3xl lg:border lg:border-zinc-200 lg:bg-white lg:shadow-sm',
        visible ? 'flex' : 'hidden lg:flex'
      ].join(' ')}
    >
      <div className="hidden px-3 py-3 sm:px-4 lg:block lg:border-b lg:border-zinc-200">
        <h2 className="text-lg font-semibold">Terminal</h2>
      </div>
      <div className="terminal-shell min-w-0 flex-1 overflow-hidden bg-transparent p-0 sm:p-2 lg:rounded-b-3xl lg:bg-white lg:p-3">
        <div
          ref={viewportRef}
          className="h-full overflow-x-auto overflow-y-auto overscroll-contain touch-pan-y [scrollbar-gutter:stable]"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div
            ref={hostRef}
            className="terminal-frame min-h-full min-w-full bg-transparent px-3 py-3 text-[12px] leading-[1.2] text-zinc-900 sm:px-4 lg:rounded-2xl lg:bg-white lg:px-5 lg:py-4"
          >
            <span
              aria-hidden="true"
              data-terminal-measure="true"
              className="pointer-events-none absolute -top-96 left-0 opacity-0"
            >
              {TERMINAL_MEASURE_TEXT}
            </span>
            {frameSnapshot && frameSnapshot.lines.length > 0 ? (
              frameSnapshot.lines.map((line, index) => {
                const isCursorLine = cursorBufferLineIndex === index;
                if (isCursorLine) {
                  return (
                    <div key={index} className="terminal-frame-line">
                      {renderCursorLine(line, frameSnapshot.cursorX)}
                    </div>
                  );
                }

                return (
                  <div key={index} className="terminal-frame-line">
                    {line.runs.length === 0
                      ? '\u00a0'
                      : line.runs.map((run, runIndex) => (
                          <span key={`${index}:${runIndex}`} style={resolveRunStyle(run.style)}>
                            {run.text || '\u00a0'}
                          </span>
                        ))}
                  </div>
                );
              })
            ) : (
              <div className="terminal-frame-line text-zinc-400">{'\u00a0'}</div>
            )}
          </div>
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
