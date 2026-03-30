import type {
  DirectoryEntrySummary,
  GitDiffFileResultPayload,
  GitStatusFileSummary,
  ListGitStatusFilesResultPayload,
  ReadProjectFileResultPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';

export type FileBrowserTab = 'changes' | 'directories';
export type FileDetailTab = 'diff' | 'file';

export interface DirectoryLoadState {
  entries: DirectoryEntrySummary[];
  error: string | null;
  loaded: boolean;
  loading: boolean;
}

export interface GitLoadState {
  error: string | null;
  loaded: boolean;
  loading: boolean;
  payload: ListGitStatusFilesResultPayload | null;
}

export interface FileContentState {
  error: string | null;
  loading: boolean;
  payload: ReadProjectFileResultPayload | null;
}

export interface FileDiffState {
  error: string | null;
  loading: boolean;
  payload: GitDiffFileResultPayload | null;
}

export type ProjectBrowserSelectedFile =
  | { source: 'changes'; file: GitStatusFileSummary }
  | { source: 'directories'; file: DirectoryEntrySummary };
