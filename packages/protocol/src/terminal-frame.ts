export interface TerminalFrameRun {
  style: string;
  text: string;
}

export interface TerminalFrameLine {
  wrapped: boolean;
  runs: TerminalFrameRun[];
}

export interface TerminalFrameSnapshot {
  sessionId: string | null;
  revision: number;
  cols: number;
  rows: number;
  tailStart: number;
  cursorX: number;
  cursorY: number;
  viewportY: number;
  baseY: number;
  totalLines: number;
  lines: TerminalFrameLine[];
}

export type TerminalColorMode = 'default' | 'palette' | 'rgb';

export interface TerminalFrameStyle {
  flags: number;
  fgMode: TerminalColorMode;
  fg: number;
  bgMode: TerminalColorMode;
  bg: number;
}

export type TerminalFramePatchOp =
  | {
      type: 'reset';
      snapshot: TerminalFrameSnapshot;
    }
  | {
      type: 'trimHead';
      count: number;
    }
  | {
      type: 'spliceLines';
      start: number;
      deleteCount: number;
      lines: TerminalFrameLine[];
    }
  | {
      type: 'meta';
      cols: number;
      rows: number;
      tailStart: number;
      cursorX: number;
      cursorY: number;
      viewportY: number;
      baseY: number;
      totalLines: number;
    };

export interface TerminalFramePatch {
  sessionId: string | null;
  baseRevision: number;
  revision: number;
  ops: TerminalFramePatchOp[];
}

const DEFAULT_STYLE: TerminalFrameStyle = {
  flags: 0,
  fgMode: 'default',
  fg: 0,
  bgMode: 'default',
  bg: 0
};

const ANSI_16_COLOR_PALETTE = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#949800',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff'
] as const;

function cloneTerminalFrameRun(run: TerminalFrameRun): TerminalFrameRun {
  return {
    style: run.style,
    text: run.text
  };
}

function cloneTerminalFrameLine(line: TerminalFrameLine): TerminalFrameLine {
  return {
    wrapped: line.wrapped,
    runs: line.runs.map(cloneTerminalFrameRun)
  };
}

export function cloneTerminalFrameSnapshot(snapshot: TerminalFrameSnapshot): TerminalFrameSnapshot {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    cols: snapshot.cols,
    rows: snapshot.rows,
    tailStart: snapshot.tailStart,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
    viewportY: snapshot.viewportY,
    baseY: snapshot.baseY,
    totalLines: snapshot.totalLines,
    lines: snapshot.lines.map(cloneTerminalFrameLine)
  };
}

export function createEmptyTerminalFrameSnapshot(
  sessionId: string | null = null,
  revision = 0,
  cols = 0,
  rows = 0
): TerminalFrameSnapshot {
  return {
    sessionId,
    revision,
    cols,
    rows,
    tailStart: 0,
    cursorX: 0,
    cursorY: 0,
    viewportY: 0,
    baseY: 0,
    totalLines: 0,
    lines: []
  };
}

export function terminalFrameLineEquals(left: TerminalFrameLine | undefined, right: TerminalFrameLine | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.wrapped !== right.wrapped || left.runs.length !== right.runs.length) {
    return false;
  }
  for (let index = 0; index < left.runs.length; index += 1) {
    const leftRun = left.runs[index];
    const rightRun = right.runs[index];
    if (!leftRun || !rightRun || leftRun.style !== rightRun.style || leftRun.text !== rightRun.text) {
      return false;
    }
  }
  return true;
}

export function encodeTerminalFrameStyle(style: TerminalFrameStyle): string {
  if (
    style.flags === DEFAULT_STYLE.flags &&
    style.fgMode === DEFAULT_STYLE.fgMode &&
    style.fg === DEFAULT_STYLE.fg &&
    style.bgMode === DEFAULT_STYLE.bgMode &&
    style.bg === DEFAULT_STYLE.bg
  ) {
    return '';
  }

  return `${style.flags};${style.fgMode}:${style.fg};${style.bgMode}:${style.bg}`;
}

export function decodeTerminalFrameStyle(value: string): TerminalFrameStyle {
  if (!value) {
    return DEFAULT_STYLE;
  }

  const [flagsPart = '0', fgPart = 'default:0', bgPart = 'default:0'] = value.split(';');
  const [fgModePart = 'default', fgValuePart = '0'] = fgPart.split(':');
  const [bgModePart = 'default', bgValuePart = '0'] = bgPart.split(':');
  const fgMode = normalizeColorMode(fgModePart);
  const bgMode = normalizeColorMode(bgModePart);

  return {
    flags: Number.parseInt(flagsPart, 10) || 0,
    fgMode,
    fg: Number.parseInt(fgValuePart, 10) || 0,
    bgMode,
    bg: Number.parseInt(bgValuePart, 10) || 0
  };
}

function normalizeColorMode(value: string): TerminalColorMode {
  if (value === 'palette' || value === 'rgb') {
    return value;
  }
  return 'default';
}

function rgbNumberToHex(value: number): string {
  const normalized = Math.max(0, Math.min(value, 0xffffff));
  return `#${normalized.toString(16).padStart(6, '0')}`;
}

export function terminalPaletteIndexToCss(index: number): string {
  if (index >= 0 && index < ANSI_16_COLOR_PALETTE.length) {
    return ANSI_16_COLOR_PALETTE[index] ?? ANSI_16_COLOR_PALETTE[0];
  }

  if (index >= 16 && index <= 231) {
    const cubeIndex = index - 16;
    const redIndex = Math.floor(cubeIndex / 36);
    const greenIndex = Math.floor((cubeIndex % 36) / 6);
    const blueIndex = cubeIndex % 6;
    const component = [0, 95, 135, 175, 215, 255];
    return rgbNumberToHex(
      ((component[redIndex] ?? 0) << 16) |
        ((component[greenIndex] ?? 0) << 8) |
        (component[blueIndex] ?? 0)
    );
  }

  if (index >= 232 && index <= 255) {
    const value = 8 + (index - 232) * 10;
    return rgbNumberToHex((value << 16) | (value << 8) | value);
  }

  return ANSI_16_COLOR_PALETTE[0];
}

export function resolveTerminalFrameColor(mode: TerminalColorMode, value: number, fallback: string): string {
  if (mode === 'rgb') {
    return rgbNumberToHex(value);
  }
  if (mode === 'palette') {
    return terminalPaletteIndexToCss(value);
  }
  return fallback;
}

export function applyTerminalFramePatch(
  currentSnapshot: TerminalFrameSnapshot | null,
  patch: TerminalFramePatch
): TerminalFrameSnapshot {
  let nextSnapshot = currentSnapshot ? cloneTerminalFrameSnapshot(currentSnapshot) : createEmptyTerminalFrameSnapshot();

  for (const op of patch.ops) {
    if (op.type === 'reset') {
      nextSnapshot = cloneTerminalFrameSnapshot(op.snapshot);
      continue;
    }

    if (op.type === 'spliceLines') {
      const nextLines = nextSnapshot.lines.slice();
      nextLines.splice(op.start, op.deleteCount, ...op.lines.map(cloneTerminalFrameLine));
      nextSnapshot = {
        ...nextSnapshot,
        lines: nextLines
      };
      continue;
    }

    if (op.type === 'trimHead') {
      nextSnapshot = {
        ...nextSnapshot,
        lines: nextSnapshot.lines.slice(op.count)
      };
      continue;
    }

    nextSnapshot = {
      ...nextSnapshot,
      cols: op.cols,
      rows: op.rows,
      tailStart: op.tailStart,
      cursorX: op.cursorX,
      cursorY: op.cursorY,
      viewportY: op.viewportY,
      baseY: op.baseY,
      totalLines: op.totalLines
    };
  }

  return {
    ...nextSnapshot,
    sessionId: patch.sessionId,
    revision: patch.revision,
    totalLines: nextSnapshot.lines.length
  };
}
