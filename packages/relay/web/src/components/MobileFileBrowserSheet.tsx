import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { useFileBrowserData } from '@/features/file-browser/hooks.ts';
import { appendPromptReference, formatRootLabel } from '@/features/file-browser/model.ts';
import type { FileBrowserTab, ProjectBrowserSelectedFile as SelectedSheetFile } from '@/features/file-browser/types.ts';
import {
  CloseIcon,
  FileBrowserDirectorySkeleton,
  FileBrowserDirectoryTree,
  FileBrowserGitFileGroup,
  FileBrowserIconButton,
  FileBrowserPreviewPanel,
  FilesIcon,
  GitBranchIcon,
  RefreshIcon
} from '@/features/file-browser/ui.tsx';
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

function ReferenceAddedPopup({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] z-50 flex justify-center px-4">
      <div className="max-w-[min(32rem,100%)] rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800 shadow-[0_16px_36px_rgba(16,185,129,0.16)]">
        {message}
      </div>
    </div>
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
  const handleBackFromPreview = useCallback(() => {
    setSelectedFile(null);
  }, []);

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
              <FileBrowserIconButton disabled={!projectCwd || !activeCliId} label="刷新文件列表" onClick={handleRefresh} variant="mobile">
                <RefreshIcon />
              </FileBrowserIconButton>
              <FileBrowserIconButton label="关闭文件浏览" onClick={onClose} variant="mobile">
                <CloseIcon />
              </FileBrowserIconButton>
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
                      <FileBrowserDirectorySkeleton rows={5} />
                    ) : gitState.error ? (
                      <div className="m-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                        {gitState.error}
                      </div>
                    ) : gitState.payload ? (
                      gitState.payload.stagedFiles.length === 0 && gitState.payload.unstagedFiles.length === 0 ? (
                        <div className="px-4 py-8 text-sm text-zinc-500">当前没有 git 变更文件。</div>
                      ) : (
                        <div>
                          <FileBrowserGitFileGroup
                            changeCountClassName="hidden font-mono text-[11px] sm:inline-flex sm:items-center sm:gap-1"
                            files={gitState.payload.stagedFiles}
                            label="Staged"
                            onPathLongPress={handleLongPressInsertPath}
                            onSelectFile={(file) => {
                              setSelectedFile({ source: 'changes', file });
                            }}
                            toneClass="text-emerald-700"
                          />
                          <FileBrowserGitFileGroup
                            changeCountClassName="hidden font-mono text-[11px] sm:inline-flex sm:items-center sm:gap-1"
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
                    <FileBrowserDirectoryTree
                      absolutePath={projectCwd}
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
          <FileBrowserPreviewPanel
            activeCliId={activeCliId}
            activeProviderId={activeProviderId}
            enabled={open}
            onBack={handleBackFromPreview}
            onInsertReference={handleInsertFileReference}
            projectCwd={projectCwd}
            refreshToken={detailRefreshToken}
            selectedFile={selectedFile}
            sendCommand={sendCommand}
            variant="mobile"
          />
        )}

        {referencePopupMessage ? <ReferenceAddedPopup message={referencePopupMessage} /> : null}
      </section>
    </div>
  );
}
