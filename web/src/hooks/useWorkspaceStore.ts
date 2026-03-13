import { useEffect, useState } from 'react';

import {
  loadWorkspaceState,
  saveWorkspaceState,
  type PersistedWorkspaceState,
  type ProjectThreadEntry
} from '@/lib/workspace.ts';

export interface WorkspaceStore {
  workspaceState: PersistedWorkspaceState;
  projectThreadsById: Record<string, ProjectThreadEntry[]>;
  sidebarToggleTop: number;
  patchWorkspace: (updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState) => void;
  setProjectThreads: (projectId: string, updater: (threads: ProjectThreadEntry[]) => ProjectThreadEntry[]) => void;
  setSidebarToggleTop: (value: number) => void;
  commitSidebarToggleTop: (value: number) => void;
}

export function useWorkspaceStore(): WorkspaceStore {
  const [workspaceState, setWorkspaceState] = useState<PersistedWorkspaceState>(() => loadWorkspaceState());
  const [projectThreadsById, setProjectThreadsById] = useState<Record<string, ProjectThreadEntry[]>>({});
  const [sidebarToggleTop, setSidebarToggleTop] = useState(() => workspaceState.sidebarToggleTop);

  useEffect(() => {
    saveWorkspaceState(workspaceState);
  }, [workspaceState]);

  useEffect(() => {
    setSidebarToggleTop(workspaceState.sidebarToggleTop);
  }, [workspaceState.sidebarToggleTop]);

  function patchWorkspace(updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState): void {
    setWorkspaceState((current) => updater(current));
  }

  function setProjectThreads(projectId: string, updater: (threads: ProjectThreadEntry[]) => ProjectThreadEntry[]): void {
    setProjectThreadsById((current) => ({
      ...current,
      [projectId]: updater(current[projectId] ?? [])
    }));
  }

  function commitSidebarToggleTop(value: number): void {
    setSidebarToggleTop(value);
    setWorkspaceState((current) => (current.sidebarToggleTop === value ? current : { ...current, sidebarToggleTop: value }));
  }

  return {
    workspaceState,
    projectThreadsById,
    sidebarToggleTop,
    patchWorkspace,
    setProjectThreads,
    setSidebarToggleTop,
    commitSidebarToggleTop
  };
}
