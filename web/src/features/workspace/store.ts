import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { ChatMessage, RuntimeSnapshot } from '@shared/runtime-types.ts';

import { createEmptySnapshot } from '@/lib/runtime.ts';
import {
  loadWorkspaceState,
  saveWorkspaceState,
  type PersistedWorkspaceState,
  type ProjectThreadEntry
} from '@/lib/workspace.ts';

import type { WorkspacePane } from './types.ts';

export interface WorkspaceStore {
  error: string;
  hasOlderMessages: boolean;
  mobilePane: WorkspacePane;
  olderMessages: ChatMessage[];
  olderMessagesLoading: boolean;
  projectLoadingId: string | null;
  projectThreadsById: Record<string, ProjectThreadEntry[]>;
  projectsRefreshing: boolean;
  prompt: string;
  sidebarToggleTop: number;
  snapshot: RuntimeSnapshot;
  workspaceState: PersistedWorkspaceState;
  commitSidebarToggleTop: (value: number) => void;
  patchWorkspace: (updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState) => void;
  setError: Dispatch<SetStateAction<string>>;
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>;
  setMobilePane: Dispatch<SetStateAction<WorkspacePane>>;
  setOlderMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setOlderMessagesLoading: Dispatch<SetStateAction<boolean>>;
  setProjectLoadingId: Dispatch<SetStateAction<string | null>>;
  setProjectThreads: (projectId: string, updater: (threads: ProjectThreadEntry[]) => ProjectThreadEntry[]) => void;
  setProjectsRefreshing: Dispatch<SetStateAction<boolean>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSidebarToggleTop: Dispatch<SetStateAction<number>>;
  setSnapshot: Dispatch<SetStateAction<RuntimeSnapshot>>;
}

export function useWorkspaceStore(): WorkspaceStore {
  const [workspaceState, setWorkspaceState] = useState<PersistedWorkspaceState>(() => loadWorkspaceState());
  const [projectThreadsById, setProjectThreadsById] = useState<Record<string, ProjectThreadEntry[]>>({});
  const [sidebarToggleTop, setSidebarToggleTop] = useState(() => workspaceState.sidebarToggleTop);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(createEmptySnapshot());
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [projectsRefreshing, setProjectsRefreshing] = useState(false);
  const [projectLoadingId, setProjectLoadingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [mobilePane, setMobilePane] = useState<WorkspacePane>('chat');

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
    error,
    hasOlderMessages,
    mobilePane,
    olderMessages,
    olderMessagesLoading,
    projectLoadingId,
    projectThreadsById,
    projectsRefreshing,
    prompt,
    sidebarToggleTop,
    snapshot,
    workspaceState,
    commitSidebarToggleTop,
    patchWorkspace,
    setError,
    setHasOlderMessages,
    setMobilePane,
    setOlderMessages,
    setOlderMessagesLoading,
    setProjectLoadingId,
    setProjectThreads,
    setProjectsRefreshing,
    setPrompt,
    setSidebarToggleTop,
    setSnapshot
  };
}
