import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';
import type { Socket } from 'socket.io-client';

import type { TerminalChunkPayload, TerminalResizePayload, TerminalResumeRequestPayload, TerminalResumeResultPayload } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import {
  MOBILE_TERMINAL_BREAKPOINT,
  MOBILE_TERMINAL_MIN_COLS,
  getUtf8ByteLength
} from '@/lib/runtime.ts';

interface UseTerminalBridgeOptions {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  socketRef: React.RefObject<Socket | null>;
  setError: Dispatch<SetStateAction<string>>;
}

interface ResumeOptions {
  force?: boolean;
}

export interface TerminalBridge {
  terminalViewportRef: React.RefObject<HTMLDivElement | null>;
  terminalHostRef: React.RefObject<HTMLDivElement | null>;
  clearTerminal: () => void;
  handleSocketConnected: () => void;
  handleSocketDisconnected: () => void;
  handleTerminalChunk: (payload: TerminalChunkPayload) => void;
  jumpToEdge: (direction: 'up' | 'down') => void;
  prepareForResume: () => void;
  resumeSession: (targetSessionId: string | null, options?: ResumeOptions) => Promise<void>;
  scheduleResize: () => void;
}

type TerminalBridgeMethods = Omit<TerminalBridge, 'terminalViewportRef' | 'terminalHostRef'>;

export function useTerminalBridge({ activeCliId, activeProviderId, socketRef, setError }: UseTerminalBridgeOptions): TerminalBridge {
  const terminalViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lastTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const appliedTerminalOffsetRef = useRef(0);
  const appliedSessionIdRef = useRef<string | null>(null);
  const appliedCliIdRef = useRef<string | null>(null);
  const appliedProviderIdRef = useRef<ProviderId | null>(null);
  const terminalResumePendingRef = useRef(false);
  const terminalResyncRequestedRef = useRef(false);
  const bufferedTerminalChunksRef = useRef<TerminalChunkPayload[]>([]);
  const terminalMethodsRef = useRef<TerminalBridgeMethods | null>(null);
  const terminalBridgeRef = useRef<TerminalBridge | null>(null);

  function scheduleResize(): void {
    if (resizeFrameRef.current) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      emitTerminalResize();
    });
  }

  function scheduleTerminalRedraw(): void {
    requestAnimationFrame(() => {
      scheduleResize();
      requestAnimationFrame(() => {
        const terminal = terminalInstanceRef.current;
        if (!terminal || terminal.rows <= 0) {
          return;
        }
        terminal.refresh(0, terminal.rows - 1);
      });
    });
  }

  function ensureTerminalBottom(): void {
    requestAnimationFrame(() => {
      const terminal = terminalInstanceRef.current;
      if (!terminal) {
        return;
      }
      terminal.scrollToBottom();
    });
  }

  function applyTerminalReplay(sessionId: string | null, replay: string, replayOffset: number): void {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    terminal.reset();

    const finalizeReplay = () => {
      appliedSessionIdRef.current = sessionId;
      appliedTerminalOffsetRef.current = replayOffset + getUtf8ByteLength(replay);
      terminal.scrollToBottom();
      scheduleTerminalRedraw();
    };

    if (!replay) {
      finalizeReplay();
      return;
    }

    terminal.write(replay, finalizeReplay);
  }

  function emitTerminalResize(): void {
    const socket = socketRef.current;
    const terminal = terminalInstanceRef.current;
    const fitAddon = fitAddonRef.current;
    const terminalHost = terminalHostRef.current;
    const terminalViewport = terminalViewportRef.current;
    if (!socket?.connected || !terminal || !fitAddon || !terminalHost || !terminalViewport) {
      return;
    }

    terminalHost.style.width = '100%';
    terminalHost.style.minWidth = '100%';
    fitAddon.fit();
    const proposedDimensions = fitAddon.proposeDimensions();
    const cols = proposedDimensions?.cols ?? terminal.cols;
    const rows = proposedDimensions?.rows ?? terminal.rows;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return;
    }

    const viewportWidth = terminalViewport.clientWidth;
    const shouldAllowHorizontalScroll = viewportWidth > 0 && viewportWidth < MOBILE_TERMINAL_BREAKPOINT;
    const nextSize = {
      cols: Math.max(shouldAllowHorizontalScroll ? MOBILE_TERMINAL_MIN_COLS : 20, cols),
      rows: Math.max(8, rows)
    };

    if (shouldAllowHorizontalScroll && cols > 0) {
      const targetWidth = Math.ceil((viewportWidth / cols) * nextSize.cols);
      terminalHost.style.width = `${targetWidth}px`;
      terminalHost.style.minWidth = `${targetWidth}px`;
    } else {
      terminalHost.style.width = '100%';
      terminalHost.style.minWidth = '100%';
    }

    if (terminal.cols !== nextSize.cols || terminal.rows !== nextSize.rows) {
      terminal.resize(nextSize.cols, nextSize.rows);
    }

    if (lastTerminalSizeRef.current?.cols === nextSize.cols && lastTerminalSizeRef.current?.rows === nextSize.rows) {
      return;
    }

    lastTerminalSizeRef.current = nextSize;
    socket.emit('web:terminal-resize', {
      targetCliId: activeCliId,
      targetProviderId: activeProviderId,
      ...nextSize
    } satisfies TerminalResizePayload);
  }

  function flushBufferedTerminalChunks(): void {
    const pendingChunks = bufferedTerminalChunksRef.current
      .splice(0)
      .sort((left, right) => left.offset - right.offset);

    for (const chunk of pendingChunks) {
      applyTerminalChunk(chunk);
    }
  }

  async function requestTerminalResume(targetSessionId: string | null): Promise<void> {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }

    const sameTargetContext =
      appliedSessionIdRef.current === targetSessionId &&
      appliedCliIdRef.current === activeCliId &&
      appliedProviderIdRef.current === activeProviderId;

    const payload: TerminalResumeRequestPayload =
      sameTargetContext
        ? {
            targetCliId: activeCliId,
            targetProviderId: activeProviderId,
            sessionId: appliedSessionIdRef.current,
            lastOffset: appliedTerminalOffsetRef.current
          }
        : {
            targetCliId: activeCliId,
            targetProviderId: activeProviderId,
            sessionId: null,
            lastOffset: 0
          };

    const result = await new Promise<TerminalResumeResultPayload>((resolve) => {
      socket.emit('web:terminal-resume', payload, (resumePayload?: TerminalResumeResultPayload) => {
        resolve(
          resumePayload ?? {
            mode: 'reset',
            providerId: activeProviderId,
            sessionId: targetSessionId,
            offset: 0,
            data: ''
          }
        );
      });
    });

    if (result.mode === 'reset') {
      applyTerminalReplay(result.sessionId, result.data, result.offset);
    } else {
      applyTerminalChunk({
        cliId: activeCliId ?? '',
        providerId: result.providerId ?? activeProviderId ?? 'claude',
        conversationKey: null,
        data: result.data,
        offset: result.offset,
        sessionId: result.sessionId
      });
    }

    appliedCliIdRef.current = activeCliId;
    appliedProviderIdRef.current = activeProviderId;

    terminalResumePendingRef.current = false;
    setError((current) => (current === '终端流已失步，正在自动重连同步...' ? '' : current));
    flushBufferedTerminalChunks();
    ensureTerminalBottom();
  }

  function scheduleTerminalResync(sessionId: string | null): void {
    if (terminalResumePendingRef.current || terminalResyncRequestedRef.current) {
      return;
    }

    terminalResyncRequestedRef.current = true;
    terminalResumePendingRef.current = true;
    bufferedTerminalChunksRef.current = [];
    setError('终端流已失步，正在自动重连同步...');
    void requestTerminalResume(sessionId).finally(() => {
      terminalResyncRequestedRef.current = false;
    });
  }

  function applyTerminalChunk(payload: TerminalChunkPayload): boolean {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return true;
    }
    if (!payload.sessionId) {
      return true;
    }
    if (payload.sessionId !== appliedSessionIdRef.current) {
      scheduleTerminalResync(payload.sessionId);
      return false;
    }

    const chunkEndOffset = payload.offset + getUtf8ByteLength(payload.data);
    if (chunkEndOffset <= appliedTerminalOffsetRef.current) {
      return true;
    }
    if (payload.offset !== appliedTerminalOffsetRef.current) {
      scheduleTerminalResync(payload.sessionId);
      return false;
    }

    terminal.write(payload.data);
    appliedTerminalOffsetRef.current = chunkEndOffset;
    return true;
  }

  function prepareForResume(): void {
    terminalResumePendingRef.current = true;
    bufferedTerminalChunksRef.current = [];
  }

  function clearTerminal(): void {
    bufferedTerminalChunksRef.current = [];
    terminalResumePendingRef.current = false;
    terminalResyncRequestedRef.current = false;
    appliedCliIdRef.current = null;
    appliedProviderIdRef.current = null;
    applyTerminalReplay(null, '', 0);
  }

  function handleSocketConnected(): void {
    terminalResumePendingRef.current = true;
    terminalResyncRequestedRef.current = false;
    bufferedTerminalChunksRef.current = [];
    setError('');
    scheduleResize();
  }

  function handleSocketDisconnected(): void {
    terminalResyncRequestedRef.current = false;
  }

  function handleTerminalChunk(payload: TerminalChunkPayload): void {
    if (terminalResumePendingRef.current) {
      bufferedTerminalChunksRef.current.push(payload);
      return;
    }
    applyTerminalChunk(payload);
  }

  async function resumeSession(targetSessionId: string | null, options: ResumeOptions = {}): Promise<void> {
    if (!socketRef.current?.connected) {
      return;
    }
    if (!options.force) {
      if (terminalResumePendingRef.current) {
        return;
      }
      if (
        appliedSessionIdRef.current === targetSessionId &&
        appliedCliIdRef.current === activeCliId &&
        appliedProviderIdRef.current === activeProviderId
      ) {
        return;
      }
    }

    prepareForResume();
    await requestTerminalResume(targetSessionId);
  }

  function jumpToEdge(direction: 'up' | 'down'): void {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    if (direction === 'up') {
      terminal.scrollToTop();
      return;
    }

    terminal.scrollToBottom();
  }

  useEffect(() => {
    if (!terminalHostRef.current || !terminalViewportRef.current || terminalInstanceRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cols: 120,
      rows: 32,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: 'Berkeley Mono, SFMono-Regular, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#ffffff',
        foreground: '#111827',
        cursor: '#111827',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(15, 23, 42, 0.12)'
      }
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminalInstanceRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      scheduleResize();
    });
    observer.observe(terminalViewportRef.current);

    const handleWindowResize = () => {
      scheduleResize();
    };

    window.addEventListener('resize', handleWindowResize);
    scheduleResize();

    return () => {
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      terminal.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  terminalMethodsRef.current = {
    clearTerminal,
    handleSocketConnected,
    handleSocketDisconnected,
    handleTerminalChunk,
    jumpToEdge,
    prepareForResume,
    resumeSession,
    scheduleResize
  };

  if (!terminalBridgeRef.current) {
    terminalBridgeRef.current = {
      terminalViewportRef,
      terminalHostRef,
      clearTerminal: () => {
        terminalMethodsRef.current?.clearTerminal();
      },
      handleSocketConnected: () => {
        terminalMethodsRef.current?.handleSocketConnected();
      },
      handleSocketDisconnected: () => {
        terminalMethodsRef.current?.handleSocketDisconnected();
      },
      handleTerminalChunk: (payload) => {
        terminalMethodsRef.current?.handleTerminalChunk(payload);
      },
      jumpToEdge: (direction) => {
        terminalMethodsRef.current?.jumpToEdge(direction);
      },
      prepareForResume: () => {
        terminalMethodsRef.current?.prepareForResume();
      },
      resumeSession: (targetSessionId, options) => {
        return terminalMethodsRef.current?.resumeSession(targetSessionId, options) ?? Promise.resolve();
      },
      scheduleResize: () => {
        terminalMethodsRef.current?.scheduleResize();
      }
    };
  }

  return terminalBridgeRef.current;
}
