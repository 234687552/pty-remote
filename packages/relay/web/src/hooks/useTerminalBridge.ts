import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { Socket } from 'socket.io-client';

import type {
  TerminalFramePatchPayload,
  TerminalFrameSyncRequestPayload,
  TerminalFrameSyncResultPayload,
  TerminalResizePayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import {
  applyTerminalFramePatch,
  cloneTerminalFrameSnapshot,
  createEmptyTerminalFrameSnapshot,
  type TerminalFramePatch,
  type TerminalFrameSnapshot
} from '@lzdi/pty-remote-protocol/terminal-frame.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { MOBILE_TERMINAL_BREAKPOINT, MOBILE_TERMINAL_MIN_COLS } from '@/lib/runtime.ts';

interface UseTerminalBridgeOptions {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  socketRef: RefObject<Socket | null>;
  setError: Dispatch<SetStateAction<string>>;
  terminalVisible: boolean;
}

interface ResumeOptions {
  force?: boolean;
}

export interface TerminalBridge {
  frameSnapshot: TerminalFrameSnapshot | null;
  terminalHostRef: RefObject<HTMLDivElement | null>;
  terminalViewportRef: RefObject<HTMLDivElement | null>;
  clearTerminal: () => void;
  handleSocketConnected: () => void;
  handleSocketDisconnected: () => void;
  handleTerminalFramePatch: (payload: TerminalFramePatchPayload) => void;
  jumpToEdge: (direction: 'up' | 'down') => void;
  prepareForResume: () => void;
  resumeSession: (targetSessionId: string | null, options?: ResumeOptions) => Promise<void>;
  scheduleResize: () => void;
}

type TerminalBridgeMethods = Omit<TerminalBridge, 'frameSnapshot' | 'terminalHostRef' | 'terminalViewportRef'>;

const TERMINAL_FONT_SIZE_PX = 12;
const TERMINAL_LINE_HEIGHT = 1.2;
const TERMINAL_MEASURE_TEXT = 'MMMMMMMMMM';
const TERMINAL_SCROLL_BOTTOM_THRESHOLD_PX = 12;

interface TerminalMeasure {
  cellHeight: number;
  cellWidth: number;
}

interface CommitFrameSnapshotOptions {
  forceScrollToBottom?: boolean;
  preserveScroll?: boolean;
}

function isResetPatch(patch: TerminalFramePatch): boolean {
  return patch.ops.some((op) => op.type === 'reset');
}

function readTerminalMeasure(host: HTMLDivElement | null): TerminalMeasure {
  const measureElement = host?.querySelector<HTMLElement>('[data-terminal-measure]');
  if (!measureElement) {
    return {
      cellWidth: TERMINAL_FONT_SIZE_PX * 0.6,
      cellHeight: TERMINAL_FONT_SIZE_PX * TERMINAL_LINE_HEIGHT
    };
  }

  const measureRect = measureElement.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(measureElement);
  const fontSize = Number.parseFloat(computedStyle.fontSize) || TERMINAL_FONT_SIZE_PX;
  const fallbackHeight = fontSize * TERMINAL_LINE_HEIGHT;

  return {
    cellWidth: measureRect.width > 0 ? measureRect.width / TERMINAL_MEASURE_TEXT.length : fontSize * 0.6,
    cellHeight: measureRect.height > 0 ? measureRect.height : fallbackHeight
  };
}

function applySyncResult(currentSnapshot: TerminalFrameSnapshot | null, result: TerminalFrameSyncResultPayload): TerminalFrameSnapshot {
  if (!result.ok) {
    throw new Error(result.error || 'Terminal frame sync failed');
  }

  if (result.mode === 'snapshot') {
    if (!result.snapshot) {
      throw new Error('Terminal frame sync returned no snapshot');
    }
    return cloneTerminalFrameSnapshot(result.snapshot);
  }

  if (result.mode !== 'patches' || !result.patches) {
    throw new Error('Terminal frame sync returned an invalid payload');
  }

  let nextSnapshot = currentSnapshot;
  for (const patch of result.patches) {
    nextSnapshot = applyTerminalFramePatch(nextSnapshot, patch);
  }

  if (!nextSnapshot) {
    throw new Error('Terminal frame sync returned no applicable patches');
  }

  return nextSnapshot;
}

export function useTerminalBridge({
  activeCliId,
  activeProviderId,
  socketRef,
  setError,
  terminalVisible
}: UseTerminalBridgeOptions): TerminalBridge {
  const terminalViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lastTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const appliedSessionIdRef = useRef<string | null>(null);
  const appliedCliIdRef = useRef<string | null>(null);
  const appliedProviderIdRef = useRef<ProviderId | null>(null);
  const terminalResumePendingRef = useRef(false);
  const terminalResyncRequestedRef = useRef(false);
  const terminalPinnedToBottomRef = useRef(true);
  const bufferedTerminalPatchesRef = useRef<TerminalFramePatchPayload[]>([]);
  const frameSnapshotRef = useRef<TerminalFrameSnapshot | null>(null);
  const terminalMethodsRef = useRef<TerminalBridgeMethods | null>(null);
  const terminalBridgeRef = useRef<TerminalBridge | null>(null);
  const [frameSnapshot, setFrameSnapshot] = useState<TerminalFrameSnapshot | null>(null);

  function commitFrameSnapshot(nextSnapshot: TerminalFrameSnapshot | null, options: CommitFrameSnapshotOptions = {}): void {
    frameSnapshotRef.current = nextSnapshot;
    setFrameSnapshot(nextSnapshot);
    requestAnimationFrame(() => {
      if (!options.preserveScroll && (options.forceScrollToBottom || terminalPinnedToBottomRef.current)) {
        jumpToEdge('down');
      }
      scheduleResize();
    });
  }

  function scheduleResize(): void {
    if (resizeFrameRef.current) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      emitTerminalResize();
    });
  }

  function emitTerminalResize(): void {
    const socket = socketRef.current;
    const terminalHost = terminalHostRef.current;
    const terminalViewport = terminalViewportRef.current;
    if (!socket?.connected || !terminalHost || !terminalViewport) {
      return;
    }

    const { cellHeight, cellWidth } = readTerminalMeasure(terminalHost);
    if (!Number.isFinite(cellHeight) || cellHeight <= 0 || !Number.isFinite(cellWidth) || cellWidth <= 0) {
      return;
    }

    const viewportWidth = terminalViewport.clientWidth;
    const viewportHeight = terminalViewport.clientHeight;
    const proposedCols = Math.max(1, Math.floor(viewportWidth / cellWidth));
    const proposedRows = Math.max(1, Math.floor(viewportHeight / cellHeight));
    const shouldAllowHorizontalScroll = viewportWidth > 0 && viewportWidth < MOBILE_TERMINAL_BREAKPOINT;
    const nextSize = {
      cols: Math.max(shouldAllowHorizontalScroll ? MOBILE_TERMINAL_MIN_COLS : 20, proposedCols),
      rows: Math.max(8, proposedRows)
    };

    if (shouldAllowHorizontalScroll) {
      const targetWidth = Math.ceil(cellWidth * nextSize.cols);
      terminalHost.style.width = `${targetWidth}px`;
      terminalHost.style.minWidth = `${targetWidth}px`;
    } else {
      terminalHost.style.width = '100%';
      terminalHost.style.minWidth = '100%';
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

  function flushBufferedTerminalPatches(): void {
    const pendingPatches = bufferedTerminalPatchesRef.current.splice(0);
    for (const pendingPatch of pendingPatches) {
      applyFramePatchPayload(pendingPatch);
    }
  }

  async function requestTerminalFrameSync(
    targetSessionId: string | null,
    options: { forceScrollToBottom?: boolean } = {}
  ): Promise<void> {
    const socket = socketRef.current;
    if (!socket?.connected) {
      throw new Error('Socket is not connected');
    }
    if (!terminalVisible) {
      throw new Error('Terminal is not visible');
    }

    const currentSnapshot = frameSnapshotRef.current;
    const sameTargetContext =
      currentSnapshot &&
      currentSnapshot.sessionId === targetSessionId &&
      appliedCliIdRef.current === activeCliId &&
      appliedProviderIdRef.current === activeProviderId;

    const payload: TerminalFrameSyncRequestPayload = sameTargetContext
      ? {
          targetCliId: activeCliId,
          targetProviderId: activeProviderId,
          sessionId: currentSnapshot.sessionId,
          lastRevision: currentSnapshot.revision
        }
      : {
          targetCliId: activeCliId,
          targetProviderId: activeProviderId,
          sessionId: targetSessionId,
          lastRevision: null
        };

    const result = await new Promise<TerminalFrameSyncResultPayload>((resolve) => {
      socket.emit('web:terminal-frame-sync', payload, (syncResult?: TerminalFrameSyncResultPayload) => {
        resolve(
          syncResult ?? {
            ok: false,
            error: 'No response from terminal frame sync',
            providerId: activeProviderId,
            sessionId: targetSessionId
          }
        );
      });
    });

    commitFrameSnapshot(applySyncResult(frameSnapshotRef.current, result), {
      forceScrollToBottom: options.forceScrollToBottom
    });
    appliedSessionIdRef.current = targetSessionId;
    appliedCliIdRef.current = activeCliId;
    appliedProviderIdRef.current = activeProviderId;
    terminalResumePendingRef.current = false;
    setError((current) => (current === '终端帧已失步，正在自动重连同步...' ? '' : current));
    flushBufferedTerminalPatches();
  }

  function scheduleTerminalResync(sessionId: string | null): void {
    if (terminalResumePendingRef.current || terminalResyncRequestedRef.current) {
      return;
    }

    terminalResyncRequestedRef.current = true;
    terminalResumePendingRef.current = true;
    bufferedTerminalPatchesRef.current = [];
    setError('终端帧已失步，正在自动重连同步...');
    void requestTerminalFrameSync(sessionId)
      .catch((error) => {
        terminalResumePendingRef.current = false;
        setError(error instanceof Error ? error.message : '终端帧重同步失败');
      })
      .finally(() => {
        terminalResyncRequestedRef.current = false;
      });
  }

  function applyFramePatchPayload(payload: TerminalFramePatchPayload): boolean {
    const patch = payload.patch;
    const currentSnapshot = frameSnapshotRef.current;
    if (!currentSnapshot && !isResetPatch(patch)) {
      scheduleTerminalResync(patch.sessionId);
      return false;
    }

    if (
      currentSnapshot &&
      !isResetPatch(patch) &&
      (patch.sessionId !== currentSnapshot.sessionId || patch.baseRevision !== currentSnapshot.revision)
    ) {
      scheduleTerminalResync(patch.sessionId);
      return false;
    }

    commitFrameSnapshot(applyTerminalFramePatch(currentSnapshot, patch));
    return true;
  }

  function prepareForResume(): void {
    terminalResumePendingRef.current = true;
    bufferedTerminalPatchesRef.current = [];
  }

  function clearTerminal(): void {
    bufferedTerminalPatchesRef.current = [];
    terminalResumePendingRef.current = false;
    terminalResyncRequestedRef.current = false;
    appliedSessionIdRef.current = null;
    appliedCliIdRef.current = null;
    appliedProviderIdRef.current = null;
    commitFrameSnapshot(createEmptyTerminalFrameSnapshot());
  }

  function handleSocketConnected(): void {
    terminalResumePendingRef.current = true;
    terminalResyncRequestedRef.current = false;
    bufferedTerminalPatchesRef.current = [];
    setError('');
    scheduleResize();
  }

  function handleSocketDisconnected(): void {
    terminalResyncRequestedRef.current = false;
  }

  function handleTerminalFramePatch(payload: TerminalFramePatchPayload): void {
    if (!terminalVisible) {
      return;
    }
    if (terminalResumePendingRef.current) {
      bufferedTerminalPatchesRef.current.push(payload);
      return;
    }
    applyFramePatchPayload(payload);
  }

  async function resumeSession(targetSessionId: string | null, options: ResumeOptions = {}): Promise<void> {
    if (!terminalVisible) {
      return;
    }
    if (!socketRef.current?.connected) {
      return;
    }

    if (!options.force) {
      if (terminalResumePendingRef.current) {
        return;
      }
      const currentSnapshot = frameSnapshotRef.current;
      if (
        currentSnapshot &&
        currentSnapshot.sessionId === targetSessionId &&
        appliedCliIdRef.current === activeCliId &&
        appliedProviderIdRef.current === activeProviderId
      ) {
        return;
      }
    }

    const currentSnapshot = frameSnapshotRef.current;
    const isTargetContextChanged =
      currentSnapshot?.sessionId !== targetSessionId ||
      appliedCliIdRef.current !== activeCliId ||
      appliedProviderIdRef.current !== activeProviderId;

    prepareForResume();
    if (isTargetContextChanged) {
      commitFrameSnapshot(createEmptyTerminalFrameSnapshot(targetSessionId ?? null), {
        preserveScroll: false,
        forceScrollToBottom: true
      });
    }
    await requestTerminalFrameSync(targetSessionId, { forceScrollToBottom: isTargetContextChanged });
  }

  function jumpToEdge(direction: 'up' | 'down'): void {
    const viewport = terminalViewportRef.current;
    if (!viewport) {
      return;
    }

    terminalPinnedToBottomRef.current = direction === 'down';

    if (direction === 'up') {
      viewport.scrollTop = 0;
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    const terminalViewport = terminalViewportRef.current;
    if (!terminalHost || !terminalViewport) {
      return;
    }

    const updatePinnedToBottom = () => {
      terminalPinnedToBottomRef.current = isViewportScrolledToBottom(terminalViewport);
    };
    updatePinnedToBottom();

    const observer = new ResizeObserver(() => {
      updatePinnedToBottom();
      scheduleResize();
    });
    observer.observe(terminalViewport);

    const handleWindowResize = () => {
      updatePinnedToBottom();
      scheduleResize();
    };

    terminalViewport.addEventListener('scroll', updatePinnedToBottom, { passive: true });
    window.addEventListener('resize', handleWindowResize);
    scheduleResize();

    return () => {
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      observer.disconnect();
      terminalViewport.removeEventListener('scroll', updatePinnedToBottom);
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  terminalMethodsRef.current = {
    clearTerminal,
    handleSocketConnected,
    handleSocketDisconnected,
    handleTerminalFramePatch,
    jumpToEdge,
    prepareForResume,
    resumeSession,
    scheduleResize
  };

  if (!terminalBridgeRef.current) {
    terminalBridgeRef.current = {
      frameSnapshot,
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
      handleTerminalFramePatch: (payload) => {
        terminalMethodsRef.current?.handleTerminalFramePatch(payload);
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

  terminalBridgeRef.current.frameSnapshot = frameSnapshot;

  return terminalBridgeRef.current;
}

function isViewportScrolledToBottom(viewport: HTMLDivElement): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= TERMINAL_SCROLL_BOTTOM_THRESHOLD_PX;
}
