import xtermHeadless from '@xterm/headless';
import type { IBufferCell, IBufferLine } from '@xterm/headless';

import {
  cloneTerminalFrameSnapshot,
  encodeTerminalFrameStyle,
  type TerminalFrameLine,
  type TerminalFramePatch,
  type TerminalFrameSnapshot,
  type TerminalFrameStyle
} from '@lzdi/pty-remote-protocol/terminal-frame.ts';

const STYLE_FLAG_BOLD = 1 << 0;
const STYLE_FLAG_ITALIC = 1 << 1;
const STYLE_FLAG_DIM = 1 << 2;
const STYLE_FLAG_UNDERLINE = 1 << 3;
const STYLE_FLAG_BLINK = 1 << 4;
const STYLE_FLAG_INVERSE = 1 << 5;
const STYLE_FLAG_INVISIBLE = 1 << 6;
const STYLE_FLAG_STRIKETHROUGH = 1 << 7;
const STYLE_FLAG_OVERLINE = 1 << 8;
const DEFAULT_SCROLLBACK = 500;
const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof xtermHeadless.Terminal>;

interface MaterializedSnapshot {
  lineKeys: string[];
  snapshot: TerminalFrameSnapshot;
}

interface HeadlessTerminalFrameStateOptions {
  cols: number;
  maxLines?: number;
  rows: number;
  scrollback?: number;
}

const DEFAULT_MAX_LINES = 500;

function sanitizeCols(cols: number): number {
  return Number.isFinite(cols) ? Math.max(20, Math.min(Math.floor(cols), 400)) : 120;
}

function sanitizeRows(rows: number): number {
  return Number.isFinite(rows) ? Math.max(8, Math.min(Math.floor(rows), 200)) : 32;
}

function createHeadlessTerminal(cols: number, rows: number, scrollback: number): HeadlessTerminal {
  return new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    convertEol: false,
    cursorBlink: false,
    cursorStyle: 'bar',
    disableStdin: true,
    logLevel: 'off',
    scrollback
  });
}

function buildLineKey(line: TerminalFrameLine): string {
  return `${line.wrapped ? '1' : '0'}:${line.runs.map((run) => `${run.style}:${run.text}`).join('|')}`;
}

function getChangedRange(previous: string[], next: string[]): {
  deleteCount: number;
  insertCount: number;
  start: number;
} {
  let start = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (start < sharedLength && previous[start] === next[start]) {
    start += 1;
  }

  let previousEnd = previous.length - 1;
  let nextEnd = next.length - 1;
  while (previousEnd >= start && nextEnd >= start && previous[previousEnd] === next[nextEnd]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    deleteCount: Math.max(0, previousEnd - start + 1),
    insertCount: Math.max(0, nextEnd - start + 1)
  };
}

function hasMetaChanged(previous: TerminalFrameSnapshot, next: TerminalFrameSnapshot): boolean {
  return (
    previous.cols !== next.cols ||
    previous.rows !== next.rows ||
    previous.tailStart !== next.tailStart ||
    previous.cursorX !== next.cursorX ||
    previous.cursorY !== next.cursorY ||
    previous.viewportY !== next.viewportY ||
    previous.baseY !== next.baseY ||
    previous.totalLines !== next.totalLines
  );
}

function normalizeStyleColor(mode: TerminalFrameStyle['fgMode'], value: number): number {
  if (mode === 'default') {
    return 0;
  }
  return value;
}

export class HeadlessTerminalFrameState {
  private terminal: HeadlessTerminal;

  private materializedSnapshot: MaterializedSnapshot;

  private readonly maxLines: number;

  private readonly scrollback: number;

  private generation = 0;

  private pendingWriteChain: Promise<void> = Promise.resolve();

  constructor(options: HeadlessTerminalFrameStateOptions) {
    const cols = sanitizeCols(options.cols);
    const rows = sanitizeRows(options.rows);
    this.maxLines = Number.isFinite(options.maxLines) ? Math.max(50, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES)) : DEFAULT_MAX_LINES;
    this.scrollback = options.scrollback ?? Math.max(DEFAULT_SCROLLBACK, this.maxLines);
    this.terminal = createHeadlessTerminal(cols, rows, this.scrollback);
    this.materializedSnapshot = this.materializeSnapshot(null, 0);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  getSnapshot(): TerminalFrameSnapshot {
    return cloneTerminalFrameSnapshot(this.materializedSnapshot.snapshot);
  }

  async flush(): Promise<void> {
    await this.pendingWriteChain;
  }

  reset(sessionId: string | null): TerminalFramePatch {
    const previousTerminal = this.terminal;
    const previousWriteChain = this.pendingWriteChain;
    this.generation += 1;
    this.terminal = createHeadlessTerminal(
      this.materializedSnapshot.snapshot.cols || 120,
      this.materializedSnapshot.snapshot.rows || 32,
      this.scrollback
    );
    void previousWriteChain.finally(() => {
      previousTerminal.dispose();
    });
    this.materializedSnapshot = this.materializeSnapshot(sessionId, 0);
    return this.createResetPatch();
  }

  resize(cols: number, rows: number): TerminalFramePatch | null {
    const nextCols = sanitizeCols(cols);
    const nextRows = sanitizeRows(rows);
    if (this.materializedSnapshot.snapshot.cols === nextCols && this.materializedSnapshot.snapshot.rows === nextRows) {
      return null;
    }

    this.terminal.resize(nextCols, nextRows);
    return this.commitFrame({ forceReset: true });
  }

  enqueueOutput(chunk: string): Promise<TerminalFramePatch | null> {
    const writeGeneration = this.generation;
    const writeTerminal = this.terminal;
    const writeTask = this.pendingWriteChain
      .catch(() => undefined)
      .then(
        () =>
          new Promise<TerminalFramePatch | null>((resolve, reject) => {
            if (writeGeneration !== this.generation || writeTerminal !== this.terminal) {
              resolve(null);
              return;
            }

            writeTerminal.write(chunk, () => {
              if (writeGeneration !== this.generation || writeTerminal !== this.terminal) {
                resolve(null);
                return;
              }

              try {
                resolve(this.commitFrame());
              } catch (error) {
                reject(error);
              }
            });
          })
      );

    this.pendingWriteChain = writeTask.then(() => undefined, () => undefined);
    return writeTask;
  }

  createResetPatch(): TerminalFramePatch {
    return {
      sessionId: this.materializedSnapshot.snapshot.sessionId,
      baseRevision: 0,
      revision: this.materializedSnapshot.snapshot.revision,
      ops: [
        {
          type: 'reset',
          snapshot: cloneTerminalFrameSnapshot(this.materializedSnapshot.snapshot)
        }
      ]
    };
  }

  private commitFrame(options: { forceReset?: boolean } = {}): TerminalFramePatch | null {
    const previous = this.materializedSnapshot;
    const nextRevision = previous.snapshot.revision + 1;
    const next = this.materializeSnapshot(previous.snapshot.sessionId, nextRevision);
    const metaChanged = hasMetaChanged(previous.snapshot, next.snapshot);
    const shift = next.snapshot.tailStart - previous.snapshot.tailStart;
    const shiftPatch = shift > 0 ? this.createTailShiftPatch(previous, next, shift) : null;
    const range = shiftPatch ? null : getChangedRange(previous.lineKeys, next.lineKeys);
    const linesChanged = shiftPatch !== null || (range ? range.deleteCount > 0 || range.insertCount > 0 : false);

    if (!options.forceReset && !metaChanged && !linesChanged) {
      return null;
    }

    const changedSpan = shiftPatch
      ? shiftPatch.trimCount + shiftPatch.range.deleteCount + shiftPatch.range.insertCount
      : (range?.deleteCount ?? 0) + (range?.insertCount ?? 0);
    const shouldReset =
      options.forceReset === true ||
      previous.snapshot.sessionId !== next.snapshot.sessionId ||
      next.snapshot.tailStart < previous.snapshot.tailStart ||
      (shift > 0 && shiftPatch === null) ||
      (linesChanged && changedSpan > Math.max(20, Math.floor(next.snapshot.lines.length * 0.6)));

    this.materializedSnapshot = next;

    if (shouldReset) {
      return this.createResetPatch();
    }

    const ops: TerminalFramePatch['ops'] = [];
    if (shiftPatch) {
      if (shiftPatch.trimCount > 0) {
        ops.push({
          type: 'trimHead',
          count: shiftPatch.trimCount
        });
      }
      if (shiftPatch.range.deleteCount > 0 || shiftPatch.range.insertCount > 0) {
        ops.push({
          type: 'spliceLines',
          start: shiftPatch.range.start,
          deleteCount: shiftPatch.range.deleteCount,
          lines: shiftPatch.lines.map((line) => ({
            wrapped: line.wrapped,
            runs: line.runs.map((run) => ({
              style: run.style,
              text: run.text
            }))
          }))
        });
      }
    } else if (range && (range.deleteCount > 0 || range.insertCount > 0)) {
      ops.push({
        type: 'spliceLines',
        start: range.start,
        deleteCount: range.deleteCount,
        lines: next.snapshot.lines.slice(range.start, range.start + range.insertCount).map((line) => ({
          wrapped: line.wrapped,
          runs: line.runs.map((run) => ({
            style: run.style,
            text: run.text
          }))
        }))
      });
    }

    if (metaChanged) {
      ops.push({
        type: 'meta',
        cols: next.snapshot.cols,
        rows: next.snapshot.rows,
        tailStart: next.snapshot.tailStart,
        cursorX: next.snapshot.cursorX,
        cursorY: next.snapshot.cursorY,
        viewportY: next.snapshot.viewportY,
        baseY: next.snapshot.baseY,
        totalLines: next.snapshot.totalLines
      });
    }

    return {
      sessionId: next.snapshot.sessionId,
      baseRevision: previous.snapshot.revision,
      revision: next.snapshot.revision,
      ops
    };
  }

  private createTailShiftPatch(
    previous: MaterializedSnapshot,
    next: MaterializedSnapshot,
    shift: number
  ): {
    lines: TerminalFrameLine[];
    range: { deleteCount: number; insertCount: number; start: number };
    trimCount: number;
  } | null {
    if (shift <= 0 || shift > previous.lineKeys.length) {
      return null;
    }

    const trimmedPrevious = previous.lineKeys.slice(shift);
    const range = getChangedRange(trimmedPrevious, next.lineKeys);
    const changedSpan = range.deleteCount + range.insertCount;
    if (changedSpan > Math.max(8, Math.floor(next.lineKeys.length * 0.2))) {
      return null;
    }

    return {
      trimCount: shift,
      range,
      lines: next.snapshot.lines.slice(range.start, range.start + range.insertCount)
    };
  }

  private materializeSnapshot(sessionId: string | null, revision: number): MaterializedSnapshot {
    const buffer = this.terminal.buffer.active;
    const reusableCell = buffer.getNullCell();
    const lines: TerminalFrameLine[] = [];
    const lineKeys: string[] = [];

    const tailCount = Math.min(this.maxLines, buffer.length);
    const tailStart = Math.max(0, buffer.length - tailCount);

    for (let lineIndex = tailStart; lineIndex < buffer.length; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) {
        continue;
      }
      const materializedLine = this.materializeLine(line, reusableCell);
      lines.push(materializedLine);
      lineKeys.push(buildLineKey(materializedLine));
    }

    return {
      snapshot: {
        sessionId,
        revision,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        tailStart,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        totalLines: lines.length,
        lines
      },
      lineKeys
    };
  }

  private materializeLine(line: IBufferLine, reusableCell: IBufferCell): TerminalFrameLine {
    const endColumn = this.resolveLineEndColumn(line, reusableCell);
    if (endColumn === 0) {
      return {
        wrapped: line.isWrapped,
        runs: []
      };
    }

    const runs: TerminalFrameLine['runs'] = [];
    let currentStyle = '';
    let currentText = '';

    for (let column = 0; column < endColumn; column += 1) {
      const cell = line.getCell(column, reusableCell);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }

      const style = this.encodeCellStyle(cell);
      const chars = cell.getChars() || ' '.repeat(Math.max(1, cell.getWidth()));

      if (style === currentStyle) {
        currentText += chars;
        continue;
      }

      if (currentText) {
        runs.push({
          style: currentStyle,
          text: currentText
        });
      }

      currentStyle = style;
      currentText = chars;
    }

    if (currentText || runs.length === 0) {
      runs.push({
        style: currentStyle,
        text: currentText
      });
    }

    return {
      wrapped: line.isWrapped,
      runs
    };
  }

  private resolveLineEndColumn(line: IBufferLine, reusableCell: IBufferCell): number {
    for (let column = line.length - 1; column >= 0; column -= 1) {
      const cell = line.getCell(column, reusableCell);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }
      if (cell.getChars() || !cell.isAttributeDefault()) {
        return column + Math.max(1, cell.getWidth());
      }
    }
    return 0;
  }

  private encodeCellStyle(cell: IBufferCell): string {
    const fgMode = cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default';
    const bgMode = cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default';
    const style: TerminalFrameStyle = {
      flags:
        (cell.isBold() ? STYLE_FLAG_BOLD : 0) |
        (cell.isItalic() ? STYLE_FLAG_ITALIC : 0) |
        (cell.isDim() ? STYLE_FLAG_DIM : 0) |
        (cell.isUnderline() ? STYLE_FLAG_UNDERLINE : 0) |
        (cell.isBlink() ? STYLE_FLAG_BLINK : 0) |
        (cell.isInverse() ? STYLE_FLAG_INVERSE : 0) |
        (cell.isInvisible() ? STYLE_FLAG_INVISIBLE : 0) |
        (cell.isStrikethrough() ? STYLE_FLAG_STRIKETHROUGH : 0) |
        (cell.isOverline() ? STYLE_FLAG_OVERLINE : 0),
      fgMode,
      fg: normalizeStyleColor(fgMode, cell.getFgColor()),
      bgMode,
      bg: normalizeStyleColor(bgMode, cell.getBgColor())
    };

    return encodeTerminalFrameStyle(style);
  }
}
