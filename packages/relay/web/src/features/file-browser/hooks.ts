import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  GitDiffFileResultPayload,
  ListDirectoryResultPayload,
  ListGitStatusFilesResultPayload,
  ReadProjectFileResultPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import type { CliSocketController } from '@/hooks/useCliSocket.ts';

import {
  decodeBase64Utf8,
  getSelectedAbsolutePath,
  getSelectedFileKey,
  getSelectedFileName,
  getSelectedRelativePath,
  normalizeGitErrorMessage,
  statusBadge
} from './model.ts';
import type {
  DirectoryLoadState,
  FileContentState,
  FileDetailTab,
  FileDiffState,
  GitLoadState,
  ProjectBrowserSelectedFile
} from './types.ts';

interface UseFileBrowserDataParams {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  projectCwd: string | null;
  sendCommand: CliSocketController['sendCommand'];
}

export function useFileBrowserData({
  activeCliId,
  activeProviderId,
  projectCwd,
  sendCommand
}: UseFileBrowserDataParams) {
  const [gitState, setGitState] = useState<GitLoadState>({
    error: null,
    loaded: false,
    loading: false,
    payload: null
  });
  const [directoryStateByPath, setDirectoryStateByPath] = useState<Record<string, DirectoryLoadState>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['']));

  useEffect(() => {
    setGitState({
      error: null,
      loaded: false,
      loading: false,
      payload: null
    });
    setDirectoryStateByPath({});
    setExpandedPaths(new Set(['']));
  }, [activeCliId, projectCwd]);

  const loadGitStatus = useCallback(
    async (force = false) => {
      if (!projectCwd || !activeCliId) {
        return;
      }
      if (gitState.loading) {
        return;
      }
      if (!force && gitState.loaded) {
        return;
      }

      setGitState((current) => ({
        ...current,
        error: null,
        loading: true
      }));

      try {
        const result = await sendCommand('list-git-status-files', { cwd: projectCwd }, activeCliId, activeProviderId);
        setGitState({
          error: null,
          loaded: true,
          loading: false,
          payload: (result.payload as ListGitStatusFilesResultPayload | undefined) ?? null
        });
      } catch (error) {
        setGitState({
          error: normalizeGitErrorMessage(error instanceof Error ? error.message : 'Git 状态读取失败'),
          loaded: true,
          loading: false,
          payload: null
        });
      }
    },
    [activeCliId, activeProviderId, gitState.loaded, gitState.loading, projectCwd, sendCommand]
  );

  const loadDirectory = useCallback(
    async (directoryPath: string, force = false) => {
      if (!projectCwd || !activeCliId) {
        return;
      }

      const currentState = directoryStateByPath[directoryPath];
      if (!force && (currentState?.loading || currentState?.loaded)) {
        return;
      }

      setDirectoryStateByPath((current) => ({
        ...current,
        [directoryPath]: {
          entries: current[directoryPath]?.entries ?? [],
          error: null,
          loaded: current[directoryPath]?.loaded ?? false,
          loading: true
        }
      }));

      try {
        const result = await sendCommand('list-directory', { cwd: projectCwd, path: directoryPath }, activeCliId, activeProviderId);
        const payload = (result.payload as ListDirectoryResultPayload | undefined) ?? null;
        setDirectoryStateByPath((current) => ({
          ...current,
          [directoryPath]: {
            entries: payload?.entries ?? [],
            error: null,
            loaded: true,
            loading: false
          }
        }));
      } catch (error) {
        setDirectoryStateByPath((current) => ({
          ...current,
          [directoryPath]: {
            entries: current[directoryPath]?.entries ?? [],
            error: error instanceof Error ? error.message : '目录读取失败',
            loaded: true,
            loading: false
          }
        }));
      }
    },
    [activeCliId, activeProviderId, directoryStateByPath, projectCwd, sendCommand]
  );

  const toggleDirectory = useCallback(
    (directoryPath: string) => {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(directoryPath)) {
          next.delete(directoryPath);
          return next;
        }
        next.add(directoryPath);
        return next;
      });

      void loadDirectory(directoryPath);
    },
    [loadDirectory]
  );

  const refreshDirectories = useCallback(() => {
    const expanded = Array.from(expandedPaths);
    setDirectoryStateByPath({});
    for (const directoryPath of expanded.length > 0 ? expanded : ['']) {
      void loadDirectory(directoryPath, true);
    }
  }, [expandedPaths, loadDirectory]);

  return {
    gitState,
    directoryStateByPath,
    expandedPaths,
    loadGitStatus,
    loadDirectory,
    refreshDirectories,
    toggleDirectory
  };
}

interface UseFilePreviewParams {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  enabled: boolean;
  projectCwd: string | null;
  refreshToken: number;
  selectedFile: ProjectBrowserSelectedFile | null;
  sendCommand: CliSocketController['sendCommand'];
}

export function useFilePreview({
  activeCliId,
  activeProviderId,
  enabled,
  projectCwd,
  refreshToken,
  selectedFile,
  sendCommand
}: UseFilePreviewParams) {
  const selectedKey = getSelectedFileKey(selectedFile);
  const [activeDetailTab, setActiveDetailTab] = useState<FileDetailTab>('file');
  const [contentState, setContentState] = useState<FileContentState>({
    error: null,
    loading: false,
    payload: null
  });
  const [diffState, setDiffState] = useState<FileDiffState>({
    error: null,
    loading: false,
    payload: null
  });

  useEffect(() => {
    setActiveDetailTab(selectedFile?.source === 'changes' ? 'diff' : 'file');
    setContentState({
      error: null,
      loading: false,
      payload: null
    });
    setDiffState({
      error: null,
      loading: false,
      payload: null
    });
  }, [selectedKey, selectedFile?.source]);

  useEffect(() => {
    if (!enabled || !selectedFile || !projectCwd || !activeCliId) {
      return;
    }

    let cancelled = false;
    setContentState({
      error: null,
      loading: true,
      payload: null
    });

    void sendCommand('read-project-file', { cwd: projectCwd, path: getSelectedRelativePath(selectedFile) }, activeCliId, activeProviderId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setContentState({
          error: null,
          loading: false,
          payload: (result.payload as ReadProjectFileResultPayload | undefined) ?? null
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setContentState({
          error: error instanceof Error ? error.message : '文件读取失败',
          loading: false,
          payload: null
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeCliId, activeProviderId, enabled, projectCwd, refreshToken, selectedFile, sendCommand]);

  useEffect(() => {
    if (!enabled || !selectedFile || selectedFile.source !== 'changes' || !projectCwd || !activeCliId) {
      setDiffState({
        error: null,
        loading: false,
        payload: null
      });
      return;
    }

    let cancelled = false;
    setDiffState({
      error: null,
      loading: true,
      payload: null
    });

    void sendCommand(
      'git-diff-file',
      { cwd: projectCwd, path: selectedFile.file.path, staged: selectedFile.file.staged },
      activeCliId,
      activeProviderId
    )
      .then((result) => {
        if (cancelled) {
          return;
        }
        setDiffState({
          error: null,
          loading: false,
          payload: (result.payload as GitDiffFileResultPayload | undefined) ?? null
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setDiffState({
          error: normalizeGitErrorMessage(error instanceof Error ? error.message : 'Diff 读取失败'),
          loading: false,
          payload: null
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeCliId, activeProviderId, enabled, projectCwd, refreshToken, selectedFile, sendCommand]);

  const decodedContent = useMemo(() => decodeBase64Utf8(contentState.payload?.contentBase64), [contentState.payload?.contentBase64]);
  const diffContent = diffState.payload?.diff?.trim() ? diffState.payload.diff : '';
  const hasDiff = diffContent.length > 0;
  const showDiffTabs = selectedFile?.source === 'changes' && hasDiff;

  useEffect(() => {
    if (selectedFile?.source === 'changes' && activeDetailTab === 'diff' && !diffState.loading && !hasDiff) {
      setActiveDetailTab('file');
    }
  }, [activeDetailTab, diffState.loading, hasDiff, selectedFile?.source]);

  return {
    activeDetailTab,
    setActiveDetailTab,
    contentState,
    diffState,
    decodedContent,
    diffContent,
    hasDiff,
    showDiffTabs,
    fileMeta: contentState.payload,
    badge: selectedFile?.source === 'changes' ? statusBadge(selectedFile.file.status) : null,
    sourceLabel:
      selectedFile?.source === 'changes'
        ? selectedFile.file.staged
          ? 'Staged 变更文件'
          : 'Unstaged 变更文件'
        : '目录文件',
    fileName: selectedFile ? getSelectedFileName(selectedFile) : '',
    relativePath: selectedFile ? getSelectedRelativePath(selectedFile) : '',
    absolutePath: selectedFile ? getSelectedAbsolutePath(selectedFile) : ''
  };
}
