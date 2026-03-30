import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';

import type { DirectoryEntrySummary, GitStatusFileSummary } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { DiffDisplay } from '@/features/file-browser/DiffDisplay.tsx';
import { useFileBrowserData, useFilePreview } from '@/features/file-browser/hooks.ts';
import {
  appendPromptReference,
  describeGitFilePath,
  formatBytes,
  formatRootLabel,
  getSelectedFileKey,
  isSameGitFile,
  statusBadge
} from '@/features/file-browser/model.ts';
import type { ProjectBrowserSelectedFile as PreviewFile } from '@/features/file-browser/types.ts';
import type { CliSocketController } from '@/hooks/useCliSocket.ts';

interface DesktopWorkspaceBrowserProps {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  projectCwd: string | null;
  projectLabel: string;
  sendCommand: CliSocketController['sendCommand'];
  setPrompt: Dispatch<SetStateAction<string>>;
  visible: boolean;
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M15.5 6.5V3.75H12.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.9 8.15A5.75 5.75 0 1 1 9.2 4.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6.2 3.8h5.45L15 7.15v8.05a1 1 0 0 1-1 1H6.2a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.65 3.8v3.35H15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7.75 10h4.5M7.75 12.8h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
      <circle cx="6" cy="4.5" r="1.65" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="15.5" r="1.65" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14" cy="8.5" r="1.65" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 6.15v7.7a4 4 0 0 0 4-4V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M2.9 6.1a1.8 1.8 0 0 1 1.8-1.8h3.15l1.5 1.5h5.95a1.8 1.8 0 0 1 1.8 1.8v6a1.8 1.8 0 0 1-1.8 1.8H4.7a1.8 1.8 0 0 1-1.8-1.8v-7.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6 3.8h5.3L14.2 6.7v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.3 3.8v2.9h2.9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={['h-3.5 w-3.5 transition-transform duration-200', expanded ? 'rotate-90' : 'rotate-0'].join(' ')}
    >
      <path d="m8 5.75 4 4.25-4 4.25" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="m11.75 5.5-4.5 4.5 4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MentionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M12.5 7.75a2.5 2.5 0 1 0-2.83 4.95 2.5 2.5 0 0 0 2.83-4.95Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12.25 10.1v.9a1.6 1.6 0 0 0 3.2 0V10a5.45 5.45 0 1 0-1.4 3.65" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolbarButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-medium transition',
        active
          ? 'border-sky-200 bg-sky-50 text-sky-700'
          : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950',
        disabled ? 'cursor-not-allowed opacity-45 shadow-none' : 'shadow-sm'
      ].join(' ')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-2xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function FileContentSkeleton() {
  const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-4/5'];

  return (
    <div role="status" aria-live="polite">
      <div className="animate-pulse space-y-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        {Array.from({ length: 12 }).map((_, index) => (
          <div key={`desktop-file-content-skeleton-${index}`} className={`h-3 rounded-full bg-zinc-200 ${widths[index % widths.length]}`} />
        ))}
      </div>
    </div>
  );
}

function PreviewTabButton({
  active,
  label,
  onClick
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-xl px-3 py-2 text-xs font-medium transition',
        active ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-500 hover:text-zinc-900'
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function GitFileRow({
  file,
  onSelectFile,
  selected
}: {
  file: GitStatusFileSummary;
  onSelectFile: (file: GitStatusFileSummary) => void;
  selected: boolean;
}) {
  const badge = statusBadge(file.status);

  return (
    <button
      type="button"
      onClick={() => onSelectFile(file)}
      className={[
        'flex w-full items-center gap-3 border-t border-zinc-100 px-4 py-3 text-left transition',
        selected ? 'bg-sky-50' : 'hover:bg-zinc-50'
      ].join(' ')}
    >
      <span className={selected ? 'text-sky-700' : 'text-zinc-500'}>
        <FileIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900">{file.fileName}</div>
        <div className="truncate text-xs text-zinc-500">{describeGitFilePath(file)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {file.linesAdded > 0 || file.linesRemoved > 0 ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
            {file.linesAdded > 0 ? <span className="text-emerald-700">+{file.linesAdded}</span> : null}
            {file.linesRemoved > 0 ? <span className="text-red-700">-{file.linesRemoved}</span> : null}
          </span>
        ) : null}
        <span
          className={[
            'inline-flex min-w-[1.75rem] items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            badge.toneClass
          ].join(' ')}
        >
          {badge.label}
        </span>
      </div>
    </button>
  );
}

function GitFileGroup({
  files,
  label,
  onSelectFile,
  selectedFile,
  toneClass
}: {
  files: GitStatusFileSummary[];
  label: string;
  onSelectFile: (file: GitStatusFileSummary) => void;
  selectedFile: GitStatusFileSummary | null;
  toneClass: string;
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <section className="border-t border-zinc-200/80">
      <div className={['px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em]', toneClass].join(' ')}>
        {label} ({files.length})
      </div>
      <div>
        {files.map((file) => (
          <GitFileRow
            key={`${file.staged ? 'staged' : 'unstaged'}:${file.path}`}
            file={file}
            onSelectFile={onSelectFile}
            selected={selectedFile ? isSameGitFile(file, selectedFile) : false}
          />
        ))}
      </div>
    </section>
  );
}

function DirectoryFileRow({
  depth,
  entry,
  onFileSelect,
  selectedPath
}: {
  depth: number;
  entry: DirectoryEntrySummary;
  onFileSelect: (entry: DirectoryEntrySummary) => void;
  selectedPath: string | null;
}) {
  const selected = selectedPath === entry.path;

  return (
    <button
      type="button"
      onClick={() => onFileSelect(entry)}
      className={[
        'flex w-full items-center gap-3 px-4 py-2.5 text-left transition',
        selected ? 'bg-sky-50' : 'hover:bg-zinc-50'
      ].join(' ')}
      style={{ paddingLeft: 16 + depth * 18 }}
    >
      <span className="h-4 w-4 shrink-0" />
      <span className={selected ? 'text-sky-700' : 'text-zinc-500'}>
        <FileIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900">{entry.name}</div>
      </div>
    </button>
  );
}

function DirectoryNode({
  directoryStateByPath,
  expandedPaths,
  label,
  onFileSelect,
  onToggleDirectory,
  path,
  selectedPath
}: {
  directoryStateByPath: Record<string, DirectoryLoadState>;
  expandedPaths: Set<string>;
  label: string;
  onFileSelect: (entry: DirectoryEntrySummary) => void;
  onToggleDirectory: (path: string) => void;
  path: string;
  selectedPath: string | null;
}) {
  const isExpanded = expandedPaths.has(path);
  const directoryState = directoryStateByPath[path];
  const depth = path ? path.split('/').length : 0;
  const childDepth = depth + 1;
  const entries = directoryState?.entries ?? [];
  const directories = entries.filter((entry) => entry.type === 'directory');
  const files = entries.filter((entry) => entry.type === 'file');
  const others = entries.filter((entry) => entry.type === 'other');

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleDirectory(path)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-zinc-50"
        style={{ paddingLeft: 16 + depth * 18 }}
      >
        <span className="flex h-4 w-4 items-center justify-center text-zinc-500">
          <ChevronIcon expanded={isExpanded} />
        </span>
        <span className="text-sky-700">
          <FolderIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-900">{label}</div>
        </div>
      </button>

      {isExpanded ? (
        directoryState?.loading ? (
          <div className="animate-pulse px-4 py-3" style={{ paddingLeft: 16 + childDepth * 18 }}>
            <div className="h-3 w-32 rounded-full bg-zinc-200" />
          </div>
        ) : directoryState?.error ? (
          <div
            className="mx-4 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"
            style={{ marginLeft: 16 + childDepth * 18 }}
          >
            {directoryState.error}
          </div>
        ) : (
          <div>
            {directories.map((entry) => (
              <DirectoryNode
                key={entry.path}
                directoryStateByPath={directoryStateByPath}
                expandedPaths={expandedPaths}
                label={entry.name}
                onFileSelect={onFileSelect}
                onToggleDirectory={onToggleDirectory}
                path={entry.path}
                selectedPath={selectedPath}
              />
            ))}

            {files.map((entry) => (
              <DirectoryFileRow
                key={entry.path}
                depth={childDepth}
                entry={entry}
                onFileSelect={onFileSelect}
                selectedPath={selectedPath}
              />
            ))}

            {others.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-3 px-4 py-2.5 text-zinc-400"
                style={{ paddingLeft: 16 + childDepth * 18 }}
              >
                <span className="h-4 w-4 shrink-0" />
                <span className="text-zinc-400">
                  <FileIcon />
                </span>
                <div className="truncate text-sm">{entry.name}</div>
              </div>
            ))}

            {!directoryState?.loading && directoryState?.loaded && entries.length === 0 ? (
              <div className="px-4 py-2 text-sm text-zinc-500" style={{ paddingLeft: 16 + childDepth * 18 }}>
                目录为空
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function BrowserFilePreviewInner({
  activeCliId,
  activeProviderId,
  enabled,
  onBack,
  onInsertReference,
  projectCwd,
  refreshToken,
  selectedFile,
  sendCommand
}: {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  enabled: boolean;
  onBack: () => void;
  onInsertReference: (absolutePath: string) => void;
  projectCwd: string | null;
  refreshToken: number;
  selectedFile: PreviewFile | null;
  sendCommand: CliSocketController['sendCommand'];
}) {
  const {
    activeDetailTab,
    setActiveDetailTab,
    contentState,
    diffState,
    decodedContent,
    diffContent,
    fileMeta,
    badge,
    showDiffTabs,
    sourceLabel,
    fileName,
    relativePath,
    absolutePath
  } = useFilePreview({
    activeCliId,
    activeProviderId,
    enabled,
    projectCwd,
    refreshToken,
    selectedFile,
    sendCommand
  });

  if (!selectedFile) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex items-start gap-3">
          <IconButton label="返回文件列表" onClick={onBack}>
            <BackIcon />
          </IconButton>

          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700">
            <FileIcon />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-semibold text-zinc-950">{fileName}</div>
              <div className="min-w-0 truncate text-xs text-zinc-500">{relativePath}</div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
                {sourceLabel}
              </span>
              {badge ? (
                <span
                  className={[
                    'inline-flex min-w-[1.75rem] items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                    badge.toneClass
                  ].join(' ')}
                >
                  {badge.label}
                </span>
              ) : null}
              {fileMeta ? (
                <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
                  {formatBytes(fileMeta.size)}
                </span>
              ) : null}
            </div>
          </div>

          <ToolbarButton label="插入文件引用" onClick={() => onInsertReference(absolutePath)}>
            <MentionIcon />
            <span>引用</span>
          </ToolbarButton>
        </div>

        {showDiffTabs ? (
          <div className="mt-3 inline-grid grid-cols-2 rounded-2xl bg-zinc-100 p-1">
            <PreviewTabButton active={activeDetailTab === 'diff'} label="Diff" onClick={() => setActiveDetailTab('diff')} />
            <PreviewTabButton active={activeDetailTab === 'file'} label="文件" onClick={() => setActiveDetailTab('file')} />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 p-4">
        <div className="space-y-3">
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] leading-5 text-zinc-600">
            {absolutePath}
          </div>

          {selectedFile.source === 'changes' && diffState.error ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              Diff 不可用: {diffState.error}
            </div>
          ) : null}

          {fileMeta?.truncated ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              文件较大，当前只显示前 {formatBytes(fileMeta.size)} 中的一部分内容。
            </div>
          ) : null}

          {activeDetailTab === 'diff' && showDiffTabs ? (
            diffState.loading ? (
              <FileContentSkeleton />
            ) : (
              <DiffDisplay diffContent={diffContent} />
            )
          ) : contentState.loading ? (
            <FileContentSkeleton />
          ) : contentState.error ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              {contentState.error}
            </div>
          ) : fileMeta?.isBinary ? (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-6 text-sm leading-6 text-zinc-600">
              这是一个二进制文件，当前不展示正文。
            </div>
          ) : decodedContent ? (
            <pre className="overflow-x-auto rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-[11px] leading-5 text-zinc-800">
              <code>{decodedContent}</code>
            </pre>
          ) : (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-6 text-sm leading-6 text-zinc-600">
              文件为空。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const BrowserFilePreview = memo(BrowserFilePreviewInner, (prevProps, nextProps) => {
  return (
    prevProps.activeCliId === nextProps.activeCliId &&
    prevProps.activeProviderId === nextProps.activeProviderId &&
    prevProps.enabled === nextProps.enabled &&
    prevProps.projectCwd === nextProps.projectCwd &&
    prevProps.refreshToken === nextProps.refreshToken &&
    getSelectedFileKey(prevProps.selectedFile) === getSelectedFileKey(nextProps.selectedFile)
  );
});

export function DesktopWorkspaceBrowser({
  activeCliId,
  activeProviderId,
  projectCwd,
  projectLabel,
  sendCommand,
  setPrompt,
  visible
}: DesktopWorkspaceBrowserProps) {
  const { gitState, directoryStateByPath, expandedPaths, loadGitStatus, loadDirectory, refreshDirectories, toggleDirectory } =
    useFileBrowserData({
      activeCliId,
      activeProviderId,
      projectCwd,
      sendCommand
    });
  const [selectedDiffFile, setSelectedDiffFile] = useState<GitStatusFileSummary | null>(null);
  const [selectedDirectoryFile, setSelectedDirectoryFile] = useState<DirectoryEntrySummary | null>(null);
  const [diffDetailRefreshToken, setDiffDetailRefreshToken] = useState(0);
  const [directoryDetailRefreshToken, setDirectoryDetailRefreshToken] = useState(0);
  const rootLabel = useMemo(() => formatRootLabel(projectCwd, projectLabel), [projectCwd, projectLabel]);

  useEffect(() => {
    setSelectedDiffFile(null);
    setSelectedDirectoryFile(null);
    setDiffDetailRefreshToken(0);
    setDirectoryDetailRefreshToken(0);
  }, [activeCliId, projectCwd]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadGitStatus();
    void loadDirectory('');
  }, [loadDirectory, loadGitStatus, visible]);

  const allChangedFiles = useMemo(
    () => [...(gitState.payload?.stagedFiles ?? []), ...(gitState.payload?.unstagedFiles ?? [])],
    [gitState.payload?.stagedFiles, gitState.payload?.unstagedFiles]
  );

  useEffect(() => {
    if (allChangedFiles.length === 0) {
      setSelectedDiffFile(null);
      return;
    }

    setSelectedDiffFile((current) => {
      if (!current) {
        return null;
      }
      return allChangedFiles.find((file) => isSameGitFile(file, current)) ?? null;
    });
  }, [allChangedFiles]);

  const handleInsertReference = useCallback(
    (absolutePath: string) => {
      setPrompt((current) => appendPromptReference(current, absolutePath));
    },
    [setPrompt]
  );

  const handleRefreshGitPane = useCallback(() => {
    void loadGitStatus(true);
    setDiffDetailRefreshToken((current) => current + 1);
  }, [loadGitStatus]);

  const handleRefreshDirectoryPane = useCallback(() => {
    refreshDirectories();
    setDirectoryDetailRefreshToken((current) => current + 1);
  }, [refreshDirectories]);

  const selectedGitPreview = selectedDiffFile ? ({ source: 'changes', file: selectedDiffFile } satisfies PreviewFile) : null;
  const selectedDirectoryPreview = selectedDirectoryFile
    ? ({ source: 'directories', file: selectedDirectoryFile } satisfies PreviewFile)
    : null;
  const showGitPreview = selectedGitPreview !== null;
  const showDirectoryPreview = selectedDirectoryPreview !== null;

  return (
    <div className={[visible ? 'flex' : 'hidden', 'relative min-h-0 flex-1 gap-4 overflow-hidden'].join(' ')}>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-zinc-200 bg-white shadow-sm">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-sky-700">
              <GitBranchIcon />
            </span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-sm font-semibold text-zinc-950">Git Diff</span>
              <div className="min-w-0 truncate text-xs leading-5 text-zinc-500">
                {gitState.payload?.branch ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-zinc-700">
                      <GitBranchIcon />
                      <span>{gitState.payload.branch}</span>
                    </span>
                    <span>
                      {gitState.payload.totalStaged} staged, {gitState.payload.totalUnstaged} unstaged
                    </span>
                  </span>
                ) : (
                  projectCwd ?? '当前项目未就绪'
                )}
              </div>
            </div>
          </div>

          <ToolbarButton disabled={!projectCwd || !activeCliId} label="刷新 Git 变更" onClick={handleRefreshGitPane}>
            <RefreshIcon />
            <span>刷新</span>
          </ToolbarButton>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {showGitPreview ? (
            <BrowserFilePreview
              activeCliId={activeCliId}
              activeProviderId={activeProviderId}
              enabled={visible}
              onBack={() => {
                setSelectedDiffFile(null);
              }}
              onInsertReference={handleInsertReference}
              projectCwd={projectCwd}
              refreshToken={diffDetailRefreshToken}
              selectedFile={selectedGitPreview}
              sendCommand={sendCommand}
            />
          ) : !projectCwd || !activeCliId ? (
            <div className="flex h-full items-center justify-center px-4 py-8 text-sm text-zinc-500">当前项目未就绪。</div>
          ) : gitState.loading ? (
            <div className="animate-pulse px-4 py-6">
              <div className="mb-3 h-3 w-40 rounded-full bg-zinc-200" />
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={`desktop-git-skeleton-${index}`} className="h-10 rounded-2xl bg-zinc-100" />
                ))}
              </div>
            </div>
          ) : gitState.error ? (
            <div className="m-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              {gitState.error}
            </div>
          ) : gitState.payload ? (
            gitState.payload.stagedFiles.length === 0 && gitState.payload.unstagedFiles.length === 0 ? (
              <div className="px-4 py-8 text-sm text-zinc-500">当前没有 git 变更文件。</div>
            ) : (
              <div className="h-full overflow-y-auto">
                <GitFileGroup
                  files={gitState.payload.stagedFiles}
                  label="Staged"
                  onSelectFile={setSelectedDiffFile}
                  selectedFile={selectedDiffFile}
                  toneClass="text-emerald-700"
                />
                <GitFileGroup
                  files={gitState.payload.unstagedFiles}
                  label="Unstaged"
                  onSelectFile={setSelectedDiffFile}
                  selectedFile={selectedDiffFile}
                  toneClass="text-amber-700"
                />
              </div>
            )
          ) : (
            <div className="px-4 py-8 text-sm text-zinc-500">还没有加载到 git 状态。</div>
          )}
        </div>
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-zinc-200 bg-white shadow-sm">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
              <FolderIcon />
            </span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-sm font-semibold text-zinc-950">当前目录</span>
              <div className="min-w-0 truncate text-xs leading-5 text-zinc-500">{projectCwd ?? rootLabel}</div>
            </div>
          </div>

          <ToolbarButton disabled={!projectCwd || !activeCliId} label="刷新当前目录" onClick={handleRefreshDirectoryPane}>
            <RefreshIcon />
            <span>刷新</span>
          </ToolbarButton>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {showDirectoryPreview ? (
            <BrowserFilePreview
              activeCliId={activeCliId}
              activeProviderId={activeProviderId}
              enabled={visible}
              onBack={() => {
                setSelectedDirectoryFile(null);
              }}
              onInsertReference={handleInsertReference}
              projectCwd={projectCwd}
              refreshToken={directoryDetailRefreshToken}
              selectedFile={selectedDirectoryPreview}
              sendCommand={sendCommand}
            />
          ) : !projectCwd || !activeCliId ? (
            <div className="flex h-full items-center justify-center px-4 py-8 text-sm text-zinc-500">当前项目未就绪。</div>
          ) : (
            <div className="h-full overflow-y-auto py-2">
                <DirectoryNode
                  directoryStateByPath={directoryStateByPath}
                  expandedPaths={expandedPaths}
                  label={rootLabel}
                  onFileSelect={setSelectedDirectoryFile}
                  onToggleDirectory={toggleDirectory}
                  path=""
                  selectedPath={selectedDirectoryFile?.path ?? null}
                />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
