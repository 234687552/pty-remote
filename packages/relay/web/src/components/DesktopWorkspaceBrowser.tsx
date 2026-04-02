import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { DirectoryEntrySummary, GitStatusFileSummary } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { useFileBrowserData } from '@/features/file-browser/hooks.ts';
import { appendPromptReference, formatRootLabel, isSameGitFile } from '@/features/file-browser/model.ts';
import type { ProjectBrowserSelectedFile as PreviewFile } from '@/features/file-browser/types.ts';
import {
  FileBrowserActionButton,
  FileBrowserDirectoryTree,
  FileBrowserGitFileGroup,
  FileBrowserPreviewPanel,
  FolderIcon,
  GitBranchIcon,
  RefreshIcon
} from '@/features/file-browser/ui.tsx';
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
  const handleBackFromGitPreview = useCallback(() => {
    setSelectedDiffFile(null);
  }, []);
  const handleBackFromDirectoryPreview = useCallback(() => {
    setSelectedDirectoryFile(null);
  }, []);

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

          <FileBrowserActionButton
            disabled={!projectCwd || !activeCliId}
            label="刷新 Git 变更"
            onClick={handleRefreshGitPane}
            variant="desktop"
          >
            <RefreshIcon />
            <span>刷新</span>
          </FileBrowserActionButton>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {showGitPreview ? (
            <FileBrowserPreviewPanel
              activeCliId={activeCliId}
              activeProviderId={activeProviderId}
              enabled={visible}
              onBack={handleBackFromGitPreview}
              onInsertReference={handleInsertReference}
              projectCwd={projectCwd}
              refreshToken={diffDetailRefreshToken}
              selectedFile={selectedGitPreview}
              sendCommand={sendCommand}
              variant="desktop"
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
                <FileBrowserGitFileGroup
                  files={gitState.payload.stagedFiles}
                  label="Staged"
                  onSelectFile={setSelectedDiffFile}
                  selectedFile={selectedDiffFile}
                  toneClass="text-emerald-700"
                />
                <FileBrowserGitFileGroup
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

          <FileBrowserActionButton
            disabled={!projectCwd || !activeCliId}
            label="刷新当前目录"
            onClick={handleRefreshDirectoryPane}
            variant="desktop"
          >
            <RefreshIcon />
            <span>刷新</span>
          </FileBrowserActionButton>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {showDirectoryPreview ? (
            <FileBrowserPreviewPanel
              activeCliId={activeCliId}
              activeProviderId={activeProviderId}
              enabled={visible}
              onBack={handleBackFromDirectoryPreview}
              onInsertReference={handleInsertReference}
              projectCwd={projectCwd}
              refreshToken={directoryDetailRefreshToken}
              selectedFile={selectedDirectoryPreview}
              sendCommand={sendCommand}
              variant="desktop"
            />
          ) : !projectCwd || !activeCliId ? (
            <div className="flex h-full items-center justify-center px-4 py-8 text-sm text-zinc-500">当前项目未就绪。</div>
          ) : (
            <div className="h-full overflow-y-auto py-2">
              <FileBrowserDirectoryTree
                absolutePath={projectCwd}
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
