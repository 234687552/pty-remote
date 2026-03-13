import type { ProjectSessionSummary } from '@shared/protocol.ts';
import type { ChatMessage, RuntimeSnapshot } from '@shared/runtime-types.ts';

export const PROJECTS_STORAGE_KEY = 'pty-remote.projects.v1';
export const SIDEBAR_TOGGLE_MARGIN = 16;
export const SIDEBAR_TOGGLE_SIZE = 40;

export interface ProjectThreadEntry {
  id: string;
  threadKey: string;
  sessionId: string | null;
  title: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
  draft: boolean;
}

export interface ProjectEntry {
  id: string;
  cliId: string;
  cwd: string;
  label: string;
}

export interface PersistedWorkspaceState {
  activeCliId: string | null;
  activeProjectId: string | null;
  activeThreadId: string | null;
  projects: ProjectEntry[];
  sidebarCollapsed: boolean;
  sidebarToggleTop: number;
}

export function getThreadLabel(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || cwd;
}

export function clampSidebarToggleTop(value: number, viewportHeight: number): number {
  const minTop = SIDEBAR_TOGGLE_MARGIN;
  const maxTop = Math.max(minTop, viewportHeight - SIDEBAR_TOGGLE_SIZE - SIDEBAR_TOGGLE_MARGIN);
  return Math.min(maxTop, Math.max(minTop, Math.round(value)));
}

export function createEmptyWorkspaceState(): PersistedWorkspaceState {
  return {
    activeCliId: null,
    activeProjectId: null,
    activeThreadId: null,
    projects: [],
    sidebarCollapsed: false,
    sidebarToggleTop: SIDEBAR_TOGGLE_MARGIN
  };
}

export function loadWorkspaceState(): PersistedWorkspaceState {
  try {
    const rawValue = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!rawValue) {
      return createEmptyWorkspaceState();
    }

    const parsed = JSON.parse(rawValue) as PersistedWorkspaceState;
    if (!parsed || !Array.isArray(parsed.projects)) {
      return createEmptyWorkspaceState();
    }

    return {
      activeCliId: parsed.activeCliId ?? null,
      activeProjectId: parsed.activeProjectId ?? null,
      activeThreadId: parsed.activeThreadId ?? null,
      projects: parsed.projects
        .filter((project) => project && typeof project.cwd === 'string')
        .map((project) => ({
          id: project.id,
          cliId: typeof project.cliId === 'string' ? project.cliId : '',
          cwd: project.cwd,
          label: project.label
        })),
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      sidebarToggleTop: clampSidebarToggleTop(
        typeof parsed.sidebarToggleTop === 'number' ? parsed.sidebarToggleTop : SIDEBAR_TOGGLE_MARGIN,
        window.innerHeight
      )
    };
  } catch {
    return createEmptyWorkspaceState();
  }
}

export function saveWorkspaceState(state: PersistedWorkspaceState): void {
  window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(state));
}

export function compactPreview(text: string, maxChars = 56): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Untitled thread';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function getMessagePlainText(message: ChatMessage | undefined): string {
  if (!message) {
    return '';
  }

  return message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLatestUserTextMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === 'user' && Boolean(getMessagePlainText(message)));
}

export function createDraftThread(label = 'New thread'): ProjectThreadEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    threadKey: crypto.randomUUID(),
    sessionId: null,
    title: label,
    preview: 'Start a new Claude session in this project.',
    updatedAt: now,
    messageCount: 0,
    draft: true
  };
}

export function createThreadFromSession(session: ProjectSessionSummary): ProjectThreadEntry {
  return {
    id: session.sessionId,
    threadKey: session.sessionId,
    sessionId: session.sessionId,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    draft: false
  };
}

export function sortThreads(threads: ProjectThreadEntry[]): ProjectThreadEntry[] {
  return [...threads].sort((left, right) => {
    if (left.draft !== right.draft) {
      return left.draft ? -1 : 1;
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

export function mergeProjectThreads(existingThreads: ProjectThreadEntry[], sessions: ProjectSessionSummary[]): ProjectThreadEntry[] {
  const drafts = existingThreads.filter((thread) => thread.draft && !thread.sessionId);
  const existingBySessionId = new Map<string, ProjectThreadEntry>();
  for (const thread of existingThreads) {
    if (!thread.sessionId || existingBySessionId.has(thread.sessionId)) {
      continue;
    }
    existingBySessionId.set(thread.sessionId, thread);
  }

  const merged = sessions.map((session) => {
    const existing = existingBySessionId.get(session.sessionId);
    return {
      ...(existing ?? createThreadFromSession(session)),
      sessionId: session.sessionId,
      title: session.title,
      preview: session.preview,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      draft: false
    };
  });

  return sortThreads([...drafts, ...merged]);
}

export function sortProjects(projects: ProjectEntry[]): ProjectEntry[] {
  return [...projects].sort((left, right) => left.label.localeCompare(right.label));
}

export function hydrateThreadFromSnapshot(
  thread: ProjectThreadEntry,
  snapshot: RuntimeSnapshot,
  messages: ChatMessage[]
): ProjectThreadEntry {
  const latestUserMessage = getLatestUserTextMessage(messages);
  const previewSource = getMessagePlainText(latestUserMessage);

  return {
    ...thread,
    sessionId: snapshot.sessionId,
    title: compactPreview(previewSource || thread.title, 44),
    preview: compactPreview(previewSource || thread.preview, 88),
    updatedAt: latestUserMessage?.createdAt ?? thread.updatedAt,
    messageCount: messages.length || thread.messageCount,
    draft: !snapshot.sessionId
  };
}
