import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import type { DirectoryEntrySummary, GitStatusFileSummary } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { DiffDisplay } from '@/features/file-browser/DiffDisplay.tsx';
import { useFilePreview } from '@/features/file-browser/hooks.ts';
import { describeGitFilePath, formatBytes, getSelectedFileKey, isSameGitFile, statusBadge } from '@/features/file-browser/model.ts';
import type { DirectoryLoadState, FileDetailTab, ProjectBrowserSelectedFile } from '@/features/file-browser/types.ts';
import type { CliSocketController } from '@/hooks/useCliSocket.ts';

type FileBrowserUiVariant = 'desktop' | 'mobile';

interface FileBrowserIconButtonProps {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  variant: FileBrowserUiVariant;
}

interface FileBrowserActionButtonProps {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  variant: FileBrowserUiVariant;
}

interface FileBrowserGitFileGroupProps {
  changeCountClassName?: string;
  files: GitStatusFileSummary[];
  label: string;
  onPathLongPress?: (absolutePath: string, pathLabel: string) => void;
  onSelectFile: (file: GitStatusFileSummary) => void;
  selectedFile?: GitStatusFileSummary | null;
  toneClass: string;
}

interface FileBrowserDirectoryTreeProps {
  absolutePath?: string | null;
  directoryStateByPath: Record<string, DirectoryLoadState>;
  expandedPaths: Set<string>;
  label: string;
  loadingRenderer?: (depth: number) => ReactNode;
  onFileSelect: (entry: DirectoryEntrySummary) => void;
  onPathLongPress?: (absolutePath: string, pathLabel: string) => void;
  onToggleDirectory: (path: string) => void;
  path: string;
  selectedPath?: string | null;
}

interface FileBrowserPreviewPanelProps {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  enabled: boolean;
  onBack: () => void;
  onInsertReference: (absolutePath: string) => void;
  projectCwd: string | null;
  refreshToken: number;
  selectedFile: ProjectBrowserSelectedFile | null;
  sendCommand: CliSocketController['sendCommand'];
  variant: FileBrowserUiVariant;
}

interface PreviewVariantClasses {
  containerClassName: string;
  contentContainerClassName: string;
  contentInnerClassName: string;
  headerClassName: string;
  skeletonRows: number;
  tabActiveClassName: string;
  tabBaseClassName: string;
  tabInactiveClassName: string;
  tabsClassName: string;
}

const PREVIEW_VARIANT_CLASSES: Record<FileBrowserUiVariant, PreviewVariantClasses> = {
  desktop: {
    containerClassName: 'flex h-full min-h-0 flex-col overflow-hidden bg-white',
    contentContainerClassName: 'min-h-0 flex-1 overflow-y-auto bg-zinc-50 p-4',
    contentInnerClassName: 'space-y-3',
    headerClassName: 'border-b border-zinc-200 px-4 py-3',
    skeletonRows: 12,
    tabActiveClassName: 'bg-white text-zinc-950 shadow-sm',
    tabBaseClassName: 'rounded-xl px-3 py-2 text-xs font-medium transition',
    tabInactiveClassName: 'text-zinc-500 hover:text-zinc-900',
    tabsClassName: 'mt-3 inline-grid grid-cols-2 rounded-2xl bg-zinc-100 p-1'
  },
  mobile: {
    containerClassName: 'min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]',
    contentContainerClassName: '',
    contentInnerClassName: 'space-y-3 py-4',
    headerClassName: 'sticky top-0 z-10 -mx-4 border-b border-zinc-100 bg-white/96 px-4 py-3 backdrop-blur',
    skeletonRows: 14,
    tabActiveClassName: 'bg-white text-zinc-950 shadow-[0_8px_18px_rgba(15,23,42,0.08)]',
    tabBaseClassName: 'rounded-xl px-3 py-2 text-sm font-medium transition',
    tabInactiveClassName: 'text-zinc-500 hover:text-zinc-900',
    tabsClassName: 'mt-3 grid grid-cols-2 rounded-2xl bg-zinc-100 p-1'
  }
};

export function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M15.5 6.5V3.75H12.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.9 8.15A5.75 5.75 0 1 1 9.2 4.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function FilesIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6.2 3.8h5.45L15 7.15v8.05a1 1 0 0 1-1 1H6.2a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.65 3.8v3.35H15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7.75 10h4.5M7.75 12.8h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GitBranchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
      <circle cx="6" cy="4.5" r="1.65" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="15.5" r="1.65" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14" cy="8.5" r="1.65" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 6.15v7.7a4 4 0 0 0 4-4V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M2.9 6.1a1.8 1.8 0 0 1 1.8-1.8h3.15l1.5 1.5h5.95a1.8 1.8 0 0 1 1.8 1.8v6a1.8 1.8 0 0 1-1.8 1.8H4.7a1.8 1.8 0 0 1-1.8-1.8v-7.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M6 3.8h5.3L14.2 6.7v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.3 3.8v2.9h2.9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronIcon({ expanded }: { expanded: boolean }) {
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

export function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="m11.75 5.5-4.5 4.5 4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MentionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M12.5 7.75a2.5 2.5 0 1 0-2.83 4.95 2.5 2.5 0 0 0 2.83-4.95Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12.25 10.1v.9a1.6 1.6 0 0 0 3.2 0V10a5.45 5.45 0 1 0-1.4 3.65" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FileBrowserIconButton({
  children,
  disabled = false,
  label,
  onClick,
  variant
}: FileBrowserIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        variant === 'desktop'
          ? 'flex h-10 w-10 items-center justify-center rounded-2xl border border-zinc-200 bg-white text-zinc-700 shadow-sm transition'
          : 'flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 shadow-[0_6px_18px_rgba(15,23,42,0.08)] transition',
        disabled ? 'cursor-not-allowed opacity-45 shadow-none' : 'hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950'
      ].join(' ')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function FileBrowserActionButton({
  active = false,
  children,
  disabled = false,
  label,
  onClick,
  variant
}: FileBrowserActionButtonProps) {
  const variantClassName =
    variant === 'desktop'
      ? active
        ? 'border-sky-200 bg-sky-50 text-sky-700'
        : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950'
      : disabled
        ? 'cursor-not-allowed border-zinc-200 bg-zinc-100 text-zinc-400'
        : 'border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        variant === 'desktop'
          ? 'inline-flex h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-medium transition'
          : 'inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition',
        variantClassName,
        variant === 'desktop' ? (disabled ? 'cursor-not-allowed opacity-45 shadow-none' : 'shadow-sm') : ''
      ].join(' ')}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function FileBrowserDirectorySkeleton({ depth = 0, rows = 4 }: { depth?: number; rows?: number }) {
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

export function FileBrowserFileContentSkeleton({
  rows = 12,
  keyPrefix = 'file-content-skeleton'
}: {
  keyPrefix?: string;
  rows?: number;
}) {
  const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-4/5'];

  return (
    <div role="status" aria-live="polite">
      <div className="animate-pulse space-y-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={`${keyPrefix}-${index}`} className={`h-3 rounded-full bg-zinc-200 ${widths[index % widths.length]}`} />
        ))}
      </div>
    </div>
  );
}

function useLongPressAction(onLongPress?: () => void, delayMs = 450) {
  const timerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const bind = useMemo(() => {
    if (!onLongPress) {
      return {};
    }

    return {
      onContextMenu(event: ReactMouseEvent<HTMLElement>) {
        if (longPressedRef.current) {
          event.preventDefault();
        }
      },
      onPointerCancel() {
        clearTimer();
      },
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
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
    };
  }, [clearTimer, delayMs, onLongPress]);

  const consumeLongPress = useCallback(() => {
    if (!onLongPress) {
      return false;
    }

    const didLongPress = longPressedRef.current;
    longPressedRef.current = false;
    return didLongPress;
  }, [onLongPress]);

  useEffect(() => clearTimer, [clearTimer]);

  return { bind, consumeLongPress };
}

function FileBrowserGitFileRow({
  changeCountClassName,
  file,
  onPathLongPress,
  onSelectFile,
  selected
}: {
  changeCountClassName: string;
  file: GitStatusFileSummary;
  onPathLongPress?: (absolutePath: string, pathLabel: string) => void;
  onSelectFile: (file: GitStatusFileSummary) => void;
  selected: boolean;
}) {
  const badge = statusBadge(file.status);
  const fileLongPress = useLongPressAction(
    onPathLongPress ? () => onPathLongPress(file.absolutePath, file.fileName) : undefined
  );

  return (
    <button
      type="button"
      onClick={() => {
        if (fileLongPress.consumeLongPress()) {
          return;
        }
        onSelectFile(file);
      }}
      className={[
        'flex w-full items-center gap-3 border-t border-zinc-100 px-4 py-3 text-left transition',
        selected ? 'bg-sky-50' : 'hover:bg-zinc-50'
      ].join(' ')}
      {...fileLongPress.bind}
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
          <span className={changeCountClassName}>
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

export function FileBrowserGitFileGroup({
  changeCountClassName = 'inline-flex items-center gap-1 font-mono text-[11px]',
  files,
  label,
  onPathLongPress,
  onSelectFile,
  selectedFile = null,
  toneClass
}: FileBrowserGitFileGroupProps) {
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
          <FileBrowserGitFileRow
            key={`${file.staged ? 'staged' : 'unstaged'}:${file.path}`}
            changeCountClassName={changeCountClassName}
            file={file}
            onPathLongPress={onPathLongPress}
            onSelectFile={onSelectFile}
            selected={selectedFile ? isSameGitFile(file, selectedFile) : false}
          />
        ))}
      </div>
    </section>
  );
}

function FileBrowserDirectoryFileRow({
  depth,
  entry,
  onFileSelect,
  onPathLongPress,
  selectedPath
}: {
  depth: number;
  entry: DirectoryEntrySummary;
  onFileSelect: (entry: DirectoryEntrySummary) => void;
  onPathLongPress?: (absolutePath: string, pathLabel: string) => void;
  selectedPath: string | null;
}) {
  const selected = selectedPath === entry.path;
  const fileLongPress = useLongPressAction(
    onPathLongPress ? () => onPathLongPress(entry.absolutePath, entry.name) : undefined
  );

  return (
    <button
      type="button"
      onClick={() => {
        if (fileLongPress.consumeLongPress()) {
          return;
        }
        onFileSelect(entry);
      }}
      className={[
        'flex w-full items-center gap-3 px-4 py-2.5 text-left transition',
        selected ? 'bg-sky-50' : 'hover:bg-zinc-50'
      ].join(' ')}
      style={{ paddingLeft: 16 + depth * 18 }}
      {...fileLongPress.bind}
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

function FileBrowserDirectoryNode({
  absolutePath,
  directoryStateByPath,
  expandedPaths,
  label,
  loadingRenderer,
  onFileSelect,
  onPathLongPress,
  onToggleDirectory,
  path,
  selectedPath
}: Required<Omit<FileBrowserDirectoryTreeProps, 'absolutePath'>> & { absolutePath: string }) {
  const isExpanded = expandedPaths.has(path);
  const directoryState = directoryStateByPath[path];
  const depth = path ? path.split('/').length : 0;
  const childDepth = depth + 1;
  const entries = directoryState?.entries ?? [];
  const directories = entries.filter((entry) => entry.type === 'directory');
  const files = entries.filter((entry) => entry.type === 'file');
  const others = entries.filter((entry) => entry.type === 'other');
  const directoryLongPress = useLongPressAction(
    onPathLongPress && absolutePath ? () => onPathLongPress(absolutePath, label) : undefined
  );

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
          loadingRenderer ? (
            loadingRenderer(childDepth)
          ) : (
            <FileBrowserDirectorySkeleton depth={childDepth} />
          )
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
              <FileBrowserDirectoryNode
                absolutePath={entry.absolutePath}
                directoryStateByPath={directoryStateByPath}
                expandedPaths={expandedPaths}
                key={entry.path}
                label={entry.name}
                loadingRenderer={loadingRenderer}
                onFileSelect={onFileSelect}
                onPathLongPress={onPathLongPress}
                onToggleDirectory={onToggleDirectory}
                path={entry.path}
                selectedPath={selectedPath}
              />
            ))}

            {files.map((entry) => (
              <FileBrowserDirectoryFileRow
                key={entry.path}
                depth={childDepth}
                entry={entry}
                onFileSelect={onFileSelect}
                onPathLongPress={onPathLongPress}
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

export function FileBrowserDirectoryTree({
  absolutePath = '',
  directoryStateByPath,
  expandedPaths,
  label,
  loadingRenderer,
  onFileSelect,
  onPathLongPress,
  onToggleDirectory,
  path,
  selectedPath = null
}: FileBrowserDirectoryTreeProps) {
  return (
    <FileBrowserDirectoryNode
      absolutePath={absolutePath ?? ''}
      directoryStateByPath={directoryStateByPath}
      expandedPaths={expandedPaths}
      label={label}
      loadingRenderer={loadingRenderer}
      onFileSelect={onFileSelect}
      onPathLongPress={onPathLongPress}
      onToggleDirectory={onToggleDirectory}
      path={path}
      selectedPath={selectedPath}
    />
  );
}

function FileBrowserPreviewTabButton({
  active,
  label,
  onClick,
  variant
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  variant: FileBrowserUiVariant;
}) {
  const classes = PREVIEW_VARIANT_CLASSES[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        classes.tabBaseClassName,
        active ? classes.tabActiveClassName : classes.tabInactiveClassName
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function FileBrowserPreviewTabs({
  activeTab,
  onTabChange,
  variant
}: {
  activeTab: FileDetailTab;
  onTabChange: (tab: FileDetailTab) => void;
  variant: FileBrowserUiVariant;
}) {
  const classes = PREVIEW_VARIANT_CLASSES[variant];

  return (
    <div className={classes.tabsClassName}>
      {([
        ['diff', 'Diff'],
        ['file', '文件']
      ] as const).map(([tab, label]) => (
        <FileBrowserPreviewTabButton
          key={tab}
          active={activeTab === tab}
          label={label}
          onClick={() => onTabChange(tab)}
          variant={variant}
        />
      ))}
    </div>
  );
}

function FileBrowserPreviewPanelInner({
  activeCliId,
  activeProviderId,
  enabled,
  onBack,
  onInsertReference,
  projectCwd,
  refreshToken,
  selectedFile,
  sendCommand,
  variant
}: FileBrowserPreviewPanelProps) {
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

  const classes = PREVIEW_VARIANT_CLASSES[variant];

  return (
    <div className={classes.containerClassName}>
      <div className={classes.headerClassName}>
        <div className="flex items-start gap-3">
          <FileBrowserIconButton label="返回文件列表" onClick={onBack} variant={variant}>
            <BackIcon />
          </FileBrowserIconButton>

          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700">
            <FileIcon />
          </div>

          <div className="min-w-0 flex-1">
            {variant === 'desktop' ? (
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate text-sm font-semibold text-zinc-950">{fileName}</div>
                <div className="min-w-0 truncate text-xs text-zinc-500">{relativePath}</div>
              </div>
            ) : (
              <>
                <div className="truncate text-sm font-semibold text-zinc-950">{fileName}</div>
                <div className="truncate text-xs text-zinc-500">{relativePath}</div>
              </>
            )}

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

          <FileBrowserActionButton label="插入文件引用" onClick={() => onInsertReference(absolutePath)} variant={variant}>
            <MentionIcon />
            <span>引用</span>
          </FileBrowserActionButton>
        </div>

        {showDiffTabs ? (
          <FileBrowserPreviewTabs activeTab={activeDetailTab} onTabChange={setActiveDetailTab} variant={variant} />
        ) : null}
      </div>

      <div className={classes.contentContainerClassName}>
        <div className={classes.contentInnerClassName}>
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
              <FileBrowserFileContentSkeleton keyPrefix={`file-content-skeleton-${variant}`} rows={classes.skeletonRows} />
            ) : (
              <DiffDisplay diffContent={diffContent} />
            )
          ) : contentState.loading ? (
            <FileBrowserFileContentSkeleton keyPrefix={`file-content-skeleton-${variant}`} rows={classes.skeletonRows} />
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

export const FileBrowserPreviewPanel = memo(FileBrowserPreviewPanelInner, (prevProps, nextProps) => {
  return (
    prevProps.activeCliId === nextProps.activeCliId &&
    prevProps.activeProviderId === nextProps.activeProviderId &&
    prevProps.enabled === nextProps.enabled &&
    prevProps.onBack === nextProps.onBack &&
    prevProps.onInsertReference === nextProps.onInsertReference &&
    prevProps.projectCwd === nextProps.projectCwd &&
    prevProps.refreshToken === nextProps.refreshToken &&
    prevProps.sendCommand === nextProps.sendCommand &&
    prevProps.variant === nextProps.variant &&
    getSelectedFileKey(prevProps.selectedFile) === getSelectedFileKey(nextProps.selectedFile)
  );
});
