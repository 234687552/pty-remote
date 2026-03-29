import { execFile, type ExecFileOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  DirectoryEntrySummary,
  GitDiffFileResultPayload,
  GitStatusFileState,
  GitStatusFileSummary,
  ListDirectoryResultPayload,
  ListGitStatusFilesResultPayload,
  ReadProjectFileResultPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_FILE_READ_MAX_BYTES = 512 * 1024;

type GitFileEntryV2 = {
  from?: string;
  index: string;
  path: string;
  workingTree: string;
};

type GitBranchInfo = {
  ahead?: number;
  behind?: number;
  head?: string;
};

type GitStatusSummaryV2 = {
  branch: GitBranchInfo;
  files: GitFileEntryV2[];
  untracked: string[];
};

type DiffStat = {
  added: number;
  removed: number;
};

const BRANCH_HEAD_REGEX = /^# branch\.head (.+)$/;
const ORDINARY_CHANGE_REGEX = /^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$/;
const RENAME_COPY_REGEX = /^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$/;
const UNMERGED_REGEX = /^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/;
const UNTRACKED_REGEX = /^\? (.+)$/;
const NUMSTAT_REGEX = /^(\d+|-)\t(\d+|-)\t(.*)$/;

export async function resolveProjectRoot(rawCwd: string): Promise<string> {
  const resolved = path.resolve(rawCwd);
  return fs.realpath(resolved).catch(() => resolved);
}

export async function listDirectory(projectRoot: string, requestedPath = ''): Promise<ListDirectoryResultPayload> {
  const normalizedPath = normalizeRelativePath(requestedPath);
  const absoluteDirectoryPath = resolvePathWithinProject(projectRoot, normalizedPath);
  const entries = await fs.readdir(absoluteDirectoryPath, { withFileTypes: true });
  const directoryEntries = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.resolve(absoluteDirectoryPath, entry.name);
      const relativePath = toPortableRelativePath(path.relative(projectRoot, absolutePath));
      const stats = await fs.lstat(absolutePath).catch(() => null);

      const summary: DirectoryEntrySummary = {
        absolutePath,
        name: entry.name,
        path: relativePath,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
      };

      if (stats) {
        summary.modifiedAt = stats.mtimeMs;
        summary.size = stats.size;
      }

      return summary;
    })
  );

  directoryEntries.sort((left, right) => {
    const leftRank = directoryTypeRank(left.type);
    const rightRank = directoryTypeRank(right.type);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    cwd: projectRoot,
    entries: directoryEntries,
    path: normalizedPath
  };
}

export async function listGitStatusFiles(projectRoot: string): Promise<ListGitStatusFilesResultPayload> {
  const [statusOutput, unstagedNumstatOutput, stagedNumstatOutput] = await Promise.all([
    runGitCommand(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], projectRoot),
    runGitCommand(['diff', '--numstat'], projectRoot),
    runGitCommand(['diff', '--cached', '--numstat'], projectRoot)
  ]);

  const statusSummary = parseStatusSummaryV2(statusOutput);
  const unstagedStats = parseNumstat(unstagedNumstatOutput);
  const stagedStats = parseNumstat(stagedNumstatOutput);
  const stagedFiles: GitStatusFileSummary[] = [];
  const unstagedFiles: GitStatusFileSummary[] = [];

  for (const file of statusSummary.files) {
    if (file.index !== ' ' && file.index !== '.' && file.index !== '?') {
      stagedFiles.push(
        buildGitStatusFileSummary(projectRoot, file.path, {
          linesAdded: stagedStats.get(file.path)?.added ?? 0,
          linesRemoved: stagedStats.get(file.path)?.removed ?? 0,
          oldPath: file.from,
          staged: true,
          status: toGitStatusState(file.index)
        })
      );
    }

    if (file.workingTree !== ' ' && file.workingTree !== '.') {
      unstagedFiles.push(
        buildGitStatusFileSummary(projectRoot, file.path, {
          linesAdded: unstagedStats.get(file.path)?.added ?? 0,
          linesRemoved: unstagedStats.get(file.path)?.removed ?? 0,
          oldPath: file.from,
          staged: false,
          status: toGitStatusState(file.workingTree)
        })
      );
    }
  }

  for (const untrackedPath of statusSummary.untracked) {
    if (untrackedPath.endsWith('/')) {
      continue;
    }

    unstagedFiles.push(
      buildGitStatusFileSummary(projectRoot, untrackedPath, {
        linesAdded: 0,
        linesRemoved: 0,
        staged: false,
        status: 'untracked'
      })
    );
  }

  return {
    branch: statusSummary.branch.head && !statusSummary.branch.head.startsWith('(') ? statusSummary.branch.head : null,
    cwd: projectRoot,
    stagedFiles,
    totalStaged: stagedFiles.length,
    totalUnstaged: unstagedFiles.length,
    unstagedFiles
  };
}

export async function readProjectFile(
  projectRoot: string,
  requestedPath: string,
  maxBytes = DEFAULT_FILE_READ_MAX_BYTES
): Promise<ReadProjectFileResultPayload> {
  const normalizedPath = normalizeRelativePath(requestedPath);
  const absolutePath = resolvePathWithinProject(projectRoot, normalizedPath);
  const fileHandle = await fs.open(absolutePath, 'r');

  try {
    const stats = await fileHandle.stat();
    if (!stats.isFile()) {
      throw new Error('Target is not a file');
    }

    const readLimit = Math.max(1, Math.floor(maxBytes));
    const bytesToRead = Math.min(stats.size, readLimit + 1);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
    const rawContent = buffer.subarray(0, bytesRead);
    const truncated = stats.size > readLimit;
    const visibleContent = truncated ? rawContent.subarray(0, readLimit) : rawContent;
    const isBinary = looksBinary(visibleContent);

    return {
      absolutePath,
      contentBase64: isBinary ? undefined : visibleContent.toString('base64'),
      cwd: projectRoot,
      isBinary,
      path: normalizedPath,
      size: stats.size,
      truncated
    };
  } finally {
    await fileHandle.close();
  }
}

export async function getGitDiffFile(
  projectRoot: string,
  requestedPath: string,
  staged = false
): Promise<GitDiffFileResultPayload> {
  const normalizedPath = normalizeRelativePath(requestedPath);
  resolvePathWithinProject(projectRoot, normalizedPath);
  const diff = await runGitCommand(
    staged ? ['diff', '--cached', '--no-ext-diff', '--', normalizedPath] : ['diff', '--no-ext-diff', '--', normalizedPath],
    projectRoot
  );

  return {
    cwd: projectRoot,
    diff,
    path: normalizedPath,
    staged
  };
}

function normalizeRelativePath(requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed || trimmed === '.' || trimmed === '/') {
    return '';
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '/') {
    return '';
  }

  return normalized.replace(/^\/+/, '').replace(/\/+$/, '');
}

function resolvePathWithinProject(projectRoot: string, requestedPath: string): string {
  const absolutePath = path.resolve(projectRoot, requestedPath || '.');
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Path escapes the current project');
  }
  return absolutePath;
}

function toPortableRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function directoryTypeRank(type: DirectoryEntrySummary['type']): number {
  if (type === 'directory') {
    return 0;
  }
  if (type === 'file') {
    return 1;
  }
  return 2;
}

function looksBinary(content: Uint8Array): boolean {
  if (content.length === 0) {
    return false;
  }

  let nonPrintable = 0;
  for (const value of content) {
    if (value === 0) {
      return true;
    }
    if (value < 32 && value !== 9 && value !== 10 && value !== 13) {
      nonPrintable += 1;
    }
  }

  return nonPrintable / content.length > 0.1;
}

async function runGitCommand(args: string[], cwd: string): Promise<string> {
  try {
    const options: ExecFileOptions = {
      cwd,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
      timeout: GIT_COMMAND_TIMEOUT_MS
    };
    const { stdout } = await execFileAsync('git', args, options);
    return `${stdout ?? ''}`;
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = `${commandError.stderr ?? ''}`.trim();
    const stdout = `${commandError.stdout ?? ''}`.trim();
    throw new Error(stderr || stdout || commandError.message || 'Git command failed');
  }
}

function parseStatusSummaryV2(statusOutput: string): GitStatusSummaryV2 {
  const summary: GitStatusSummaryV2 = {
    branch: {},
    files: [],
    untracked: []
  };

  for (const line of statusOutput.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    if (line.startsWith('# branch.head ')) {
      const match = BRANCH_HEAD_REGEX.exec(line);
      if (match?.[1]) {
        summary.branch.head = match[1];
      }
      continue;
    }

    if (line.startsWith('1 ')) {
      const match = ORDINARY_CHANGE_REGEX.exec(line);
      if (match?.[9]) {
        summary.files.push({
          index: match[1] ?? '.',
          path: match[9],
          workingTree: match[2] ?? '.'
        });
      }
      continue;
    }

    if (line.startsWith('2 ')) {
      const match = RENAME_COPY_REGEX.exec(line);
      if (match?.[11] && match?.[12]) {
        summary.files.push({
          from: match[11],
          index: match[1] ?? '.',
          path: match[12],
          workingTree: match[2] ?? '.'
        });
      }
      continue;
    }

    if (line.startsWith('u ')) {
      const match = UNMERGED_REGEX.exec(line);
      if (match?.[11]) {
        summary.files.push({
          index: match[1] ?? 'U',
          path: match[11],
          workingTree: match[2] ?? 'U'
        });
      }
      continue;
    }

    if (line.startsWith('? ')) {
      const match = UNTRACKED_REGEX.exec(line);
      if (match?.[1]) {
        summary.untracked.push(match[1]);
      }
    }
  }

  return summary;
}

function parseNumstat(numstatOutput: string): Map<string, DiffStat> {
  const stats = new Map<string, DiffStat>();

  for (const line of numstatOutput.split(/\r?\n/)) {
    const match = NUMSTAT_REGEX.exec(line);
    if (!match?.[3]) {
      continue;
    }

    const filePath = match[3];
    const added = match[1] === '-' ? 0 : Number.parseInt(match[1] ?? '0', 10);
    const removed = match[2] === '-' ? 0 : Number.parseInt(match[2] ?? '0', 10);
    const normalizedPaths = normalizeNumstatPath(filePath);
    const value = { added, removed };

    stats.set(filePath, value);
    if (normalizedPaths.next && normalizedPaths.next !== filePath) {
      stats.set(normalizedPaths.next, value);
    }
    if (normalizedPaths.previous && normalizedPaths.previous !== filePath && normalizedPaths.previous !== normalizedPaths.next) {
      stats.set(normalizedPaths.previous, value);
    }
  }

  return stats;
}

function normalizeNumstatPath(filePath: string): { next: string | null; previous: string | null } {
  const trimmed = filePath.trim();
  const braceRenameMatch = trimmed.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceRenameMatch) {
    const prefix = braceRenameMatch[1] ?? '';
    const previous = braceRenameMatch[2] ?? '';
    const next = braceRenameMatch[3] ?? '';
    const suffix = braceRenameMatch[4] ?? '';
    return {
      next: `${prefix}${next}${suffix}`,
      previous: `${prefix}${previous}${suffix}`
    };
  }

  if (trimmed.includes('=>')) {
    const renameParts = trimmed.split(/\s*=>\s*/);
    const previous = renameParts[0]?.trim() ?? null;
    const next = renameParts[renameParts.length - 1]?.trim() ?? null;
    return {
      next,
      previous
    };
  }

  return {
    next: null,
    previous: null
  };
}

function buildGitStatusFileSummary(
  projectRoot: string,
  filePath: string,
  options: {
    linesAdded: number;
    linesRemoved: number;
    oldPath?: string;
    staged: boolean;
    status: GitStatusFileState;
  }
): GitStatusFileSummary {
  const normalizedPath = toPortableRelativePath(filePath);
  const pathSegments = normalizedPath.split('/').filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] ?? normalizedPath;

  return {
    absolutePath: path.resolve(projectRoot, filePath),
    fileName,
    filePath: pathSegments.slice(0, -1).join('/'),
    linesAdded: options.linesAdded,
    linesRemoved: options.linesRemoved,
    oldPath: options.oldPath ? toPortableRelativePath(options.oldPath) : undefined,
    path: normalizedPath,
    staged: options.staged,
    status: options.status
  };
}

function toGitStatusState(code: string): GitStatusFileState {
  if (code === 'A') {
    return 'added';
  }
  if (code === 'D') {
    return 'deleted';
  }
  if (code === 'R' || code === 'C') {
    return 'renamed';
  }
  if (code === '?' || code === '!') {
    return 'untracked';
  }
  if (code === 'U') {
    return 'conflicted';
  }
  return 'modified';
}
