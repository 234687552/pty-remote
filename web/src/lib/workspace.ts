import type { ProjectSessionSummary } from '@shared/protocol.ts';
import { PROVIDER_LABELS, type ChatMessage, type ProviderId, type RuntimeSnapshot } from '@shared/runtime-types.ts';

export const PROJECTS_STORAGE_KEY = 'pty-remote.projects.v2';
const LEGACY_PROJECTS_STORAGE_KEY = 'pty-remote.projects.v1';
export const SIDEBAR_TOGGLE_MARGIN = 16;
export const SIDEBAR_TOGGLE_SIZE = 40;

export interface ProjectConversationEntry {
  id: string;
  providerId: ProviderId;
  conversationKey: string;
  sessionId: string | null;
  title: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
  draft: boolean;
}

export interface ProjectEntry {
  id: string;
  cwd: string;
  label: string;
}

export interface PersistedWorkspaceState {
  activeCliId: string | null;
  activeProjectId: string | null;
  activeProviderId: ProviderId | null;
  activeConversationId: string | null;
  projects: ProjectEntry[];
  sidebarCollapsed: boolean;
  sidebarToggleTop: number;
}

interface LegacyProjectEntry {
  id: string;
  cliId?: string;
  cwd: string;
  label: string;
}

interface LegacyWorkspaceState {
  activeCliId: string | null;
  activeProjectId: string | null;
  activeThreadId: string | null;
  projects: LegacyProjectEntry[];
  sidebarCollapsed: boolean;
  sidebarToggleTop: number;
}

export function getProjectProviderKey(projectId: string, providerId: ProviderId): string {
  return `${projectId}:${providerId}`;
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
    activeProviderId: null,
    activeConversationId: null,
    projects: [],
    sidebarCollapsed: false,
    sidebarToggleTop: SIDEBAR_TOGGLE_MARGIN
  };
}

function normalizeProjects(projects: { id: string; cwd: string; label: string }[]): ProjectEntry[] {
  return projects
    .filter((project) => project && typeof project.cwd === 'string')
    .map((project) => ({
      id: project.id,
      cwd: project.cwd,
      label: project.label
    }));
}

function migrateLegacyWorkspaceState(parsed: LegacyWorkspaceState): PersistedWorkspaceState {
  return {
    activeCliId: parsed.activeCliId ?? null,
    activeProjectId: parsed.activeProjectId ?? null,
    activeProviderId: 'claude',
    activeConversationId: parsed.activeThreadId ?? null,
    projects: normalizeProjects(parsed.projects ?? []),
    sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
    sidebarToggleTop: clampSidebarToggleTop(
      typeof parsed.sidebarToggleTop === 'number' ? parsed.sidebarToggleTop : SIDEBAR_TOGGLE_MARGIN,
      window.innerHeight
    )
  };
}

export function loadWorkspaceState(): PersistedWorkspaceState {
  try {
    const currentValue = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (currentValue) {
      const parsed = JSON.parse(currentValue) as PersistedWorkspaceState;
      if (parsed && Array.isArray(parsed.projects)) {
        return {
          activeCliId: parsed.activeCliId ?? null,
          activeProjectId: parsed.activeProjectId ?? null,
          activeProviderId: parsed.activeProviderId ?? null,
          activeConversationId: parsed.activeConversationId ?? null,
          projects: normalizeProjects(parsed.projects),
          sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
          sidebarToggleTop: clampSidebarToggleTop(
            typeof parsed.sidebarToggleTop === 'number' ? parsed.sidebarToggleTop : SIDEBAR_TOGGLE_MARGIN,
            window.innerHeight
          )
        };
      }
    }

    const legacyValue = window.localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY);
    if (!legacyValue) {
      return createEmptyWorkspaceState();
    }

    const parsed = JSON.parse(legacyValue) as LegacyWorkspaceState;
    if (!parsed || !Array.isArray(parsed.projects)) {
      return createEmptyWorkspaceState();
    }

    return migrateLegacyWorkspaceState(parsed);
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
    return 'Untitled conversation';
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

export function createDraftConversation(providerId: ProviderId, label = 'New conversation'): ProjectConversationEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    providerId,
    conversationKey: crypto.randomUUID(),
    sessionId: null,
    title: label,
    preview: `Start a new ${PROVIDER_LABELS[providerId]} session in this project.`,
    updatedAt: now,
    messageCount: 0,
    draft: true
  };
}

export function createConversationFromSession(session: ProjectSessionSummary): ProjectConversationEntry {
  return {
    id: `${session.providerId}:${session.sessionId}`,
    providerId: session.providerId,
    conversationKey: session.sessionId,
    sessionId: session.sessionId,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    draft: false
  };
}

export function sortConversations(conversations: ProjectConversationEntry[]): ProjectConversationEntry[] {
  return [...conversations].sort((left, right) => {
    if (left.draft !== right.draft) {
      return left.draft ? -1 : 1;
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

export function mergeProjectConversations(
  existingConversations: ProjectConversationEntry[],
  sessions: ProjectSessionSummary[],
  providerId: ProviderId
): ProjectConversationEntry[] {
  const drafts = existingConversations.filter((conversation) => conversation.draft && !conversation.sessionId);
  const existingBySessionId = new Map<string, ProjectConversationEntry>();
  for (const conversation of existingConversations) {
    if (!conversation.sessionId || conversation.providerId !== providerId || existingBySessionId.has(conversation.sessionId)) {
      continue;
    }
    existingBySessionId.set(conversation.sessionId, conversation);
  }

  const merged = sessions.map((session) => {
    const existing = existingBySessionId.get(session.sessionId);
    return {
      ...(existing ?? createConversationFromSession(session)),
      providerId,
      conversationKey: existing?.conversationKey ?? session.sessionId,
      sessionId: session.sessionId,
      title: session.title,
      preview: session.preview,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      draft: false
    };
  });

  return sortConversations([...drafts, ...merged]);
}

export function sortProjects(projects: ProjectEntry[]): ProjectEntry[] {
  return [...projects].sort((left, right) => left.label.localeCompare(right.label));
}

export function hydrateConversationFromSnapshot(
  conversation: ProjectConversationEntry,
  snapshot: RuntimeSnapshot,
  messages: ChatMessage[]
): ProjectConversationEntry {
  const latestUserMessage = getLatestUserTextMessage(messages);
  const previewSource = getMessagePlainText(latestUserMessage);

  return {
    ...conversation,
    providerId: snapshot.providerId ?? conversation.providerId,
    sessionId: snapshot.sessionId,
    title: compactPreview(previewSource || conversation.title, 44),
    preview: compactPreview(previewSource || conversation.preview, 88),
    updatedAt: latestUserMessage?.createdAt ?? conversation.updatedAt,
    messageCount: messages.length || conversation.messageCount,
    draft: !snapshot.sessionId
  };
}
