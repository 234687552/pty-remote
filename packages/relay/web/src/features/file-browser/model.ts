import type { GitStatusFileSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import type { ProjectBrowserSelectedFile } from './types.ts';

export function statusBadge(status: GitStatusFileSummary['status']): { label: string; toneClass: string } {
  if (status === 'added') {
    return { label: 'A', toneClass: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
  }
  if (status === 'deleted') {
    return { label: 'D', toneClass: 'border-red-200 bg-red-50 text-red-700' };
  }
  if (status === 'renamed') {
    return { label: 'R', toneClass: 'border-sky-200 bg-sky-50 text-sky-700' };
  }
  if (status === 'untracked') {
    return { label: '?', toneClass: 'border-amber-200 bg-amber-50 text-amber-700' };
  }
  if (status === 'conflicted') {
    return { label: 'U', toneClass: 'border-red-200 bg-red-50 text-red-700' };
  }
  return { label: 'M', toneClass: 'border-zinc-200 bg-zinc-100 text-zinc-700' };
}

export function appendPromptReference(currentPrompt: string, absolutePath: string): string {
  const reference = `@${absolutePath}`;
  const existingLines = currentPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (existingLines.includes(reference)) {
    return currentPrompt;
  }

  const trimmedEnd = currentPrompt.replace(/\s+$/g, '');
  return trimmedEnd ? `${trimmedEnd}\n${reference}` : reference;
}

export function describeGitFilePath(file: GitStatusFileSummary): string {
  return file.filePath || 'project root';
}

export function formatRootLabel(projectCwd: string | null, projectLabel: string): string {
  if (projectLabel.trim()) {
    return projectLabel.trim();
  }
  if (!projectCwd) {
    return '当前目录';
  }
  const parts = projectCwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? projectCwd;
}

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeGitErrorMessage(message: string): string {
  const normalized = message.trim().toLowerCase();
  if (normalized.includes('not a git repository') || normalized.includes('不是git仓库') || normalized.includes('不是 git 仓库')) {
    return '不是 git 仓库';
  }
  return message;
}

export function decodeBase64Utf8(value: string | undefined): string {
  if (!value) {
    return '';
  }

  try {
    const binary = window.atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function getSelectedFileKey(selectedFile: ProjectBrowserSelectedFile | null): string {
  if (!selectedFile) {
    return 'none';
  }
  if (selectedFile.source === 'changes') {
    return `${selectedFile.source}:${selectedFile.file.path}:${selectedFile.file.staged ? 'staged' : 'unstaged'}`;
  }
  return `${selectedFile.source}:${selectedFile.file.path}`;
}

export function getSelectedFileName(selectedFile: ProjectBrowserSelectedFile): string {
  return selectedFile.source === 'changes' ? selectedFile.file.fileName : selectedFile.file.name;
}

export function getSelectedAbsolutePath(selectedFile: ProjectBrowserSelectedFile): string {
  return selectedFile.file.absolutePath;
}

export function getSelectedRelativePath(selectedFile: ProjectBrowserSelectedFile): string {
  return selectedFile.file.path;
}

export function isSameGitFile(left: GitStatusFileSummary, right: GitStatusFileSummary): boolean {
  return left.path === right.path && left.staged === right.staged;
}
