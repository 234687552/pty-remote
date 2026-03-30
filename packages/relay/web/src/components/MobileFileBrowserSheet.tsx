import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { DirectoryEntrySummary, GitStatusFileSummary } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { DiffDisplay } from '@/features/file-browser/DiffDisplay.tsx';
import { useFileBrowserData, useFilePreview } from '@/features/file-browser/hooks.ts';
import {
  appendPromptReference,
  describeGitFilePath,
  formatBytes,
  formatRootLabel,
  getSelectedAbsolutePath,
  getSelectedFileKey,
  getSelectedFileName,
  getSelectedRelativePath,
  statusBadge
} from '@/features/file-browser/model.ts';
import type { DirectoryLoadState, FileBrowserTab, ProjectBrowserSelectedFile as SelectedSheetFile } from '@/features/file-browser/types.ts';
import type { CliSocketController } from '@/hooks/useCliSocket.ts';

interface MobileFileBrowserSheetProps {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  onClose: () => void;
  open: boolean;
  projectCwd: string | null;
  projectLabel: string;
  sendCommand: CliSocketController['sendCommand'];
  setPrompt: Dispatch<SetStateAction<string>>;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
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

function SheetIconButton({
  disabled = false,
  label,
  onClick,
  children
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 shadow-[0_6px_18px_rgba(15,23,42,0.08)] transition',
        disabled ? 'cursor-not-allowed opacity-45 shadow-none' : 'hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950'
      ].join(' ')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function ActionPillButton({
  disabled = false,
  label,
  onClick,
  children
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition',
        disabled
          ? 'cursor-not-allowed border-zinc-200 bg-zinc-100 text-zinc-400'
          : 'border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100'
      ].join(' ')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function useLongPressAction(onLongPress: () => void, delayMs = 450) {
  const timerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const bind = useMemo(
    () => ({
      onContextMenu(event: React.MouseEvent<HTMLElement>) {
        if (longPressedRef.current) {
          event.preventDefault();
        }
      },
      onPointerCancel() {
        clearTimer();
      },
      onPointerDown(event: React.PointerEvent<HTMLElement>) {
        if (event.pointerType === 'mouse' && event.button !== 0) {
          return;
        }

        clearTimer();
        longPressedRef.current = false;
        timerRef.current = window.setTimeout(() => {
          longPressedRef.current = true;
          onLongPress();
        }, delayMs);
      },
      onPointerLeave() {
        clearTimer();
      },
      onPointerUp() {
        clearTimer();
      }
    }),
    [clearTimer, delayMs, onLongPress]
  );

  const consumeLongPress = useCallback(() => {
    const didLongPress = longPressedRef.current;
    longPressedRef.current = false;
    return didLongPress;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  return { bind, consumeLongPress };
}

function DirectorySkeleton({ depth = 0, rows = 4 }: { depth?: number; rows?: number }) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={`directory-skeleton-${depth}-${index}`}
          className="flex items-center gap-3 px-4 py-2.5"
          style={{ paddingLeft: 16 + depth * 18 }}
        >
          <div className="h-4 w-4 rounded-full bg-zinc-200" />
          <div className="h-3 w-40 rounded-full bg-zinc-200" />
        </div>
      ))}
    </div>
  );
}

function FileContentSkeleton() {
  const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-4/5'];

  return (
    <div role="status" aria-live="polite">
      <div className="animate-pulse space-y-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        {Array.from({ length: 14 }).map((_, index) => (
          <div key={`file-content-skeleton-${index}`} className={`h-3 rounded-full bg-zinc-200 ${widths[index % widths.length]}`} />
        ))}
      </div>
    </div>
  );
}

function ReferenceAddedPopup({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] z-50 flex justify-center px-4">
      <div className="max-w-[min(32rem,100%)] rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800 shadow-[0_16px_36px_rgba(16,185,129,0.16)]">
        {message}
      </div>
    </div>
  );
}

function DirectoryFileRow({
  childDepth,
  entry,
  onFileSelect,
  onPathLongPress
}: {
  childDepth: number;
  entry: DirectoryEntrySummary;
  onFileSelect: (entry: DirectoryEntrySummary) => void;
  onPathLongPress: (absolutePath: string, pathLabel: string) => void;
}) {
  const fileLongPress = useLongPressAction(() => {
    onPathLongPress(entry.absolutePath, entry.name);
  });

  return (
    <button
      type="button"
      onClick={() => {
        if (fileLongPress.consumeLongPress()) {
          return;
        }
        onFileSelect(entry);
      }}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-zinc-50"
      style={{ paddingLeft: 16 + childDepth * 18 }}
      {...fileLongPress.bind}
    >
      <span className="h-4 w-4 shrink-0" />
      <span className="text-zinc-500">
        <FileIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900">{entry.name}</div>
      </div>
    </button>
  );
}

function GitFileRow({
  file,
  onPathLongPress,
  onSelectFile
}: {
  file: GitStatusFileSummary;
  onPathLongPress: (absolutePath: string, pathLabel: string) => void;
  onSelectFile: (file: GitStatusFileSummary) => void;
}) {
  const badge = statusBadge(file.status);
  const fileLongPress = useLongPressAction(() => {
    onPathLongPress(file.absolutePath, file.fileName);
  });

  return (
    <button
      type="button"
      onClick={() => {
        if (fileLongPress.consumeLongPress()) {
          return;
        }
        onSelectFile(file);
      }}
      className="flex w-full items-center gap-3 border-t border-zinc-100 px-4 py-3 text-left transition hover:bg-zinc-50"
      {...fileLongPress.bind}
    >
      <span className="text-zinc-500">
        <FileIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900">{file.fileName}</div>
        <div className="truncate text-xs text-zinc-500">{describeGitFilePath(file)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {file.linesAdded > 0 || file.linesRemoved > 0 ? (
          <span className="hidden font-mono text-[11px] sm:inline-flex sm:items-center sm:gap-1">
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

function DirectoryNode({
  absolutePath,
  directoryStateByPath,
  expandedPaths,
  label,
  onFileSelect,
  onPathLongPress,
  onToggleDirectory,
  path
}: {
  absolutePath: string;
  directoryStateByPath: Record<string, DirectoryLoadState>;
  expandedPaths: Set<string>;
  label: string;
  onFileSelect: (entry: DirectoryEntrySummary) => void;
  onPathLongPress: (absolutePath: string, pathLabel: string) => void;
  onToggleDirectory: (path: string) => void;
  path: string;
}) {
  const isExpanded = expandedPaths.has(path);
  const directoryState = directoryStateByPath[path];
  const depth = path ? path.split('/').length : 0;
  const childDepth = depth + 1;
  const entries = directoryState?.entries ?? [];
  const directories = entries.filter((entry) => entry.type === 'directory');
  const files = entries.filter((entry) => entry.type === 'file');
  const others = entries.filter((entry) => entry.type === 'other');
  const directoryLongPress = useLongPressAction(() => {
    onPathLongPress(absolutePath, label);
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (directoryLongPress.consumeLongPress()) {
            return;
          }
          onToggleDirectory(path);
        }}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-zinc-50"
        style={{ paddingLeft: 16 + depth * 18 }}
        {...directoryLongPress.bind}
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
          <DirectorySkeleton depth={childDepth} />
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
                absolutePath={entry.absolutePath}
                key={entry.path}
                directoryStateByPath={directoryStateByPath}
                expandedPaths={expandedPaths}
                label={entry.name}
                onFileSelect={onFileSelect}
                onPathLongPress={onPathLongPress}
                onToggleDirectory={onToggleDirectory}
                path={entry.path}
              />
            ))}

            {files.map((entry) => (
              <DirectoryFileRow
                key={entry.path}
                childDepth={childDepth}
                entry={entry}
                onFileSelect={onFileSelect}
                onPathLongPress={onPathLongPress}
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

function GitFileGroup({
  files,
  label,
  onPathLongPress,
  onSelectFile,
  toneClass
}: {
  files: GitStatusFileSummary[];
  label: string;
  onPathLongPress: (absolutePath: string, pathLabel: string) => void;
  onSelectFile: (file: GitStatusFileSummary) => void;
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
            onPathLongPress={onPathLongPress}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </section>
  );
}

function FileBrowserTabSwitcher({
  activeTab,
  onTabChange
}: {
  activeTab: FileBrowserTab;
  onTabChange: (tab: FileBrowserTab) => void;
}) {
  return (
    <div className="border-t border-zinc-100 bg-white/96 px-4 py-3 backdrop-blur">
      <div className="grid grid-cols-2 rounded-2xl bg-zinc-100 p-1">
        {([
          ['changes', 'Git 变更'],
          ['directories', '当前目录']
        ] as const).map(([tab, label]) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onTabChange(tab)}
              className={[
                'rounded-xl px-3 py-2 text-sm font-medium transition',
                active ? 'bg-white text-zinc-950 shadow-[0_8px_18px_rgba(15,23,42,0.08)]' : 'text-zinc-500 hover:text-zinc-900'
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileDetailView({
  activeCliId,
  activeProviderId,
  onBack,
  onInsertReference,
  projectCwd,
  refreshToken,
  selectedFile,
  sendCommand
}: {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  onBack: () => void;
  onInsertReference: (absolutePath: string) => void;
  projectCwd: string | null;
  refreshToken: number;
  selectedFile: SelectedSheetFile;
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
    enabled: true,
    projectCwd,
    refreshToken,
    selectedFile,
    sendCommand
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
      <div className="sticky top-0 z-10 -mx-4 border-b border-zinc-100 bg-white/96 px-4 py-3 backdrop-blur">
        <div className="flex items-start gap-3">
          <SheetIconButton label="返回文件列表" onClick={onBack}>
            <BackIcon />
          </SheetIconButton>

          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700">
            <FileIcon />
          </div>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-zinc-950">{fileName}</div>
            <div className="truncate text-xs text-zinc-500">{relativePath}</div>
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

          <ActionPillButton label="插入文件引用" onClick={() => onInsertReference(absolutePath)}>
            <MentionIcon />
            <span>引用</span>
          </ActionPillButton>
        </div>

        {showDiffTabs ? (
          <div className="mt-3 grid grid-cols-2 rounded-2xl bg-zinc-100 p-1">
            {([
              ['diff', 'Diff'],
              ['file', '文件']
            ] as const).map(([tab, label]) => {
              const active = activeDetailTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveDetailTab(tab)}
                  className={[
                    'rounded-xl px-3 py-2 text-sm font-medium transition',
                    active ? 'bg-white text-zinc-950 shadow-[0_8px_18px_rgba(15,23,42,0.08)]' : 'text-zinc-500 hover:text-zinc-900'
                  ].join(' ')}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="space-y-3 py-4">
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
  );
}

export function MobileFileBrowserSheet({
  activeCliId,
  activeProviderId,
  onClose,
  open,
  projectCwd,
  projectLabel,
  sendCommand,
  setPrompt
}: MobileFileBrowserSheetProps) {
  const [activeTab, setActiveTab] = useState<FileBrowserTab>('changes');
  const { gitState, directoryStateByPath, expandedPaths, loadGitStatus, loadDirectory, refreshDirectories, toggleDirectory } =
    useFileBrowserData({
      activeCliId,
      activeProviderId,
      projectCwd,
      sendCommand
    });
  const [recentlyInsertedPath, setRecentlyInsertedPath] = useState<string | null>(null);
  const [referencePopupMessage, setReferencePopupMessage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedSheetFile | null>(null);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const rootLabel = useMemo(() => formatRootLabel(projectCwd, projectLabel), [projectCwd, projectLabel]);

  useEffect(() => {
    setRecentlyInsertedPath(null);
    setReferencePopupMessage(null);
    setSelectedFile(null);
    setDetailRefreshToken(0);
  }, [activeCliId, projectCwd]);

  useEffect(() => {
    setSelectedFile(null);
  }, [activeTab]);

  useEffect(() => {
    if (open) {
      return;
    }
    setSelectedFile(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void loadGitStatus();
    void loadDirectory('');
  }, [loadDirectory, loadGitStatus, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!recentlyInsertedPath) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRecentlyInsertedPath(null);
    }, 2200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [recentlyInsertedPath]);

  useEffect(() => {
    if (!referencePopupMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setReferencePopupMessage(null);
    }, 1800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [referencePopupMessage]);

  const handleInsertFileReference = useCallback(
    (absolutePath: string) => {
      setPrompt((current) => appendPromptReference(current, absolutePath));
      setRecentlyInsertedPath(absolutePath);
      setReferencePopupMessage(`已添加 @${absolutePath}`);
    },
    [setPrompt]
  );

  const handleLongPressInsertPath = useCallback(
    (absolutePath: string, _pathLabel: string) => {
      handleInsertFileReference(absolutePath);
    },
    [handleInsertFileReference]
  );

  const handleRefresh = useCallback(() => {
    if (selectedFile) {
      setDetailRefreshToken((current) => current + 1);
      return;
    }

    if (activeTab === 'changes') {
      void loadGitStatus(true);
      return;
    }

    refreshDirectories();
  }, [activeTab, loadGitStatus, refreshDirectories, selectedFile]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="关闭文件浏览"
        onClick={onClose}
        className="absolute inset-0 bg-zinc-950/35 backdrop-blur-[2px]"
      />

      <section className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-white">
        <div className="flex items-center justify-center border-b border-zinc-100 px-4 pt-2">
          <span className="h-1.5 w-12 rounded-full bg-zinc-200" />
        </div>

        <div className="border-b border-zinc-100 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-sky-700">
              <FilesIcon />
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-zinc-950">文件浏览</div>
              <div className="truncate text-xs text-zinc-500">{projectCwd ?? '当前项目未就绪'}</div>
              <div className="mt-1 text-[11px] leading-5 text-zinc-500">
                {recentlyInsertedPath ? (
                  <span className="truncate text-emerald-700">已插入 {recentlyInsertedPath}</span>
                ) : selectedFile ? (
                  '查看文件详情，可插入引用或查看 diff。'
                ) : (
                  '点按查看详情，长按直接添加 @路径。'
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <SheetIconButton disabled={!projectCwd || !activeCliId} label="刷新文件列表" onClick={handleRefresh}>
                <RefreshIcon />
              </SheetIconButton>
              <SheetIconButton label="关闭文件浏览" onClick={onClose}>
                <CloseIcon />
              </SheetIconButton>
            </div>
          </div>
        </div>

        {!selectedFile ? (
          <>
            <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-y-auto">
              {activeTab === 'changes' ? (
                <div>
                  {gitState.payload?.branch ? (
                    <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 text-sm text-zinc-600">
                      <GitBranchIcon />
                      <span className="font-medium text-zinc-900">{gitState.payload.branch}</span>
                      <span className="text-xs text-zinc-500">
                        {gitState.payload.totalStaged} staged, {gitState.payload.totalUnstaged} unstaged
                      </span>
                    </div>
                  ) : null}

                  {gitState.loading ? (
                    <DirectorySkeleton rows={5} />
                  ) : gitState.error ? (
                    <div className="m-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                      {gitState.error}
                    </div>
                  ) : gitState.payload ? (
                    gitState.payload.stagedFiles.length === 0 && gitState.payload.unstagedFiles.length === 0 ? (
                      <div className="px-4 py-8 text-sm text-zinc-500">当前没有 git 变更文件。</div>
                    ) : (
                      <div>
                        <GitFileGroup
                          files={gitState.payload.stagedFiles}
                          label="Staged"
                          onPathLongPress={handleLongPressInsertPath}
                          onSelectFile={(file) => {
                            setSelectedFile({ source: 'changes', file });
                          }}
                          toneClass="text-emerald-700"
                        />
                        <GitFileGroup
                          files={gitState.payload.unstagedFiles}
                          label="Unstaged"
                          onPathLongPress={handleLongPressInsertPath}
                          onSelectFile={(file) => {
                            setSelectedFile({ source: 'changes', file });
                          }}
                          toneClass="text-amber-700"
                        />
                      </div>
                    )
                  ) : (
                    <div className="px-4 py-8 text-sm text-zinc-500">还没有加载到 git 状态。</div>
                  )}
                </div>
              ) : (
                <div className="py-2">
                  <DirectoryNode
                    absolutePath={projectCwd ?? ''}
                    directoryStateByPath={directoryStateByPath}
                    expandedPaths={expandedPaths}
                    label={rootLabel}
                    onFileSelect={(entry) => {
                      setSelectedFile({ source: 'directories', file: entry });
                    }}
                    onPathLongPress={handleLongPressInsertPath}
                    onToggleDirectory={toggleDirectory}
                    path=""
                  />
                </div>
              )}
              </div>
              <FileBrowserTabSwitcher activeTab={activeTab} onTabChange={setActiveTab} />
            </div>
          </>
        ) : (
          <FileDetailView
            activeCliId={activeCliId}
            activeProviderId={activeProviderId}
            onBack={() => {
              setSelectedFile(null);
            }}
            onInsertReference={handleInsertFileReference}
            projectCwd={projectCwd}
            refreshToken={detailRefreshToken}
            selectedFile={selectedFile}
            sendCommand={sendCommand}
          />
        )}

        {referencePopupMessage ? <ReferenceAddedPopup message={referencePopupMessage} /> : null}
      </section>
    </div>
  );
}
