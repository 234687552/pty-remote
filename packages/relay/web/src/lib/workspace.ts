import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';
import { PROVIDER_LABELS, type ChatMessage, type ProviderId, type RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

export const PROJECTS_STORAGE_KEY = 'pty-remote.projects.v2';
export const PROJECT_CONVERSATIONS_STORAGE_KEY = 'pty-remote.project-conversations.v1';
const LEGACY_PROJECTS_STORAGE_KEY = 'pty-remote.projects.v1';
export const SIDEBAR_TOGGLE_MARGIN = 16;
export const SIDEBAR_TOGGLE_SIZE = 40;

export interface ProjectConversationEntry {
  id: string;
  providerId: ProviderId;
  ownerCliId: string | null;
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

interface PersistedProjectConversationsStateV2 {
  version: 2;
  byProjectKey: Record<string, ProjectConversationEntry[]>;
  byDirectoryKey: Record<string, ProjectConversationEntry[]>;
}

export function getProjectProviderKey(projectId: string, providerId: ProviderId): string {
  return `${projectId}:${providerId}`;
}

function getDirectoryProviderKey(cwd: string, providerId: ProviderId): string {
  return `${providerId}:${encodeURIComponent(cwd)}`;
}

function parseProjectProviderKey(key: string): { projectId: string; providerId: ProviderId } | null {
  if (key.endsWith(':claude')) {
    return {
      projectId: key.slice(0, -':claude'.length),
      providerId: 'claude'
    };
  }
  if (key.endsWith(':codex')) {
    return {
      projectId: key.slice(0, -':codex'.length),
      providerId: 'codex'
    };
  }
  return null;
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

function normalizeProviderId(value: unknown): ProviderId | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

function normalizeConversationEntry(value: unknown): ProjectConversationEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Partial<ProjectConversationEntry>;
  const providerId = normalizeProviderId(raw.providerId);
  if (!providerId || typeof raw.id !== 'string') {
    return null;
  }

  const now = new Date().toISOString();
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId.trim() : null;
  const conversationKey =
    typeof raw.conversationKey === 'string' && raw.conversationKey.trim().length > 0
      ? raw.conversationKey.trim()
      : sessionId ?? crypto.randomUUID();
  const updatedAt =
    typeof raw.updatedAt === 'string' && Number.isFinite(new Date(raw.updatedAt).getTime()) ? raw.updatedAt : now;
  const messageCount = Number.isFinite(raw.messageCount) ? Math.max(0, Math.floor(raw.messageCount as number)) : 0;

  return {
    id: raw.id,
    providerId,
    ownerCliId: typeof raw.ownerCliId === 'string' && raw.ownerCliId.trim().length > 0 ? raw.ownerCliId.trim() : null,
    conversationKey,
    sessionId,
    title: typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title : 'New conversation',
    preview: typeof raw.preview === 'string' && raw.preview.trim().length > 0 ? raw.preview : '',
    updatedAt,
    messageCount,
    draft: typeof raw.draft === 'boolean' ? raw.draft : !sessionId
  };
}

function normalizeConversationsRecord(value: unknown): Record<string, ProjectConversationEntry[]> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const entries = value as Record<string, unknown>;
  const normalized: Record<string, ProjectConversationEntry[]> = {};
  for (const [key, rawConversations] of Object.entries(entries)) {
    if (!Array.isArray(rawConversations)) {
      continue;
    }

    const conversations = rawConversations.map(normalizeConversationEntry).filter(Boolean) as ProjectConversationEntry[];
    if (conversations.length > 0) {
      normalized[key] = sortConversations(conversations);
    }
  }
  return normalized;
}

export function loadProjectConversationsState(projects: ProjectEntry[] = []): Record<string, ProjectConversationEntry[]> {
  try {
    const raw = window.localStorage.getItem(PROJECT_CONVERSATIONS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    const normalizedProjects = normalizeProjects(projects);
    const byProject = normalizeConversationsRecord(
      (parsed as Partial<PersistedProjectConversationsStateV2> | null)?.byProjectKey ?? parsed
    );
    if ((parsed as Partial<PersistedProjectConversationsStateV2> | null)?.version !== 2) {
      return byProject;
    }

    const byDirectory = normalizeConversationsRecord(
      (parsed as Partial<PersistedProjectConversationsStateV2> | null)?.byDirectoryKey ?? {}
    );
    if (normalizedProjects.length === 0 || Object.keys(byDirectory).length === 0) {
      return byProject;
    }

    const restored = { ...byProject };
    for (const project of normalizedProjects) {
      for (const providerId of ['claude', 'codex'] as const) {
        const projectKey = getProjectProviderKey(project.id, providerId);
        if ((restored[projectKey] ?? []).length > 0) {
          continue;
        }
        const directoryKey = getDirectoryProviderKey(project.cwd, providerId);
        const directoryConversations = byDirectory[directoryKey];
        if (directoryConversations && directoryConversations.length > 0) {
          restored[projectKey] = directoryConversations;
        }
      }
    }

    return restored;
  } catch {
    return {};
  }
}

export function saveProjectConversationsState(
  state: Record<string, ProjectConversationEntry[]>,
  projects: ProjectEntry[] = []
): void {
  const normalizedByProject = normalizeConversationsRecord(state);
  const normalizedProjects = normalizeProjects(projects);
  const projectsById = new Map(normalizedProjects.map((project) => [project.id, project]));
  const byDirectoryKey: Record<string, ProjectConversationEntry[]> = {};

  for (const [projectKey, conversations] of Object.entries(normalizedByProject)) {
    const parsed = parseProjectProviderKey(projectKey);
    if (!parsed) {
      continue;
    }
    const project = projectsById.get(parsed.projectId);
    if (!project) {
      continue;
    }
    byDirectoryKey[getDirectoryProviderKey(project.cwd, parsed.providerId)] = conversations;
  }

  const payload: PersistedProjectConversationsStateV2 = {
    version: 2,
    byProjectKey: normalizedByProject,
    byDirectoryKey
  };
  window.localStorage.setItem(PROJECT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(payload));
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
    .join('\n')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('@/'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMessagePreviewText(message: ChatMessage | undefined): string {
  const plainText = getMessagePlainText(message);
  if (plainText) {
    return plainText;
  }

  if (!message?.attachments || message.attachments.length === 0) {
    return '';
  }

  return message.attachments.map((attachment) => attachment.filename).join(', ');
}

function getLatestUserTextMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === 'user' && Boolean(getMessagePreviewText(message)));
}

export function createDraftConversation(
  providerId: ProviderId,
  ownerCliId: string | null = null,
  label = 'New conversation'
): ProjectConversationEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    providerId,
    ownerCliId,
    conversationKey: crypto.randomUUID(),
    sessionId: null,
    title: label,
    preview: `Start a new ${PROVIDER_LABELS[providerId]} session in this project.`,
    updatedAt: now,
    messageCount: 0,
    draft: true
  };
}

export function createConversationFromSession(
  session: ProjectSessionSummary,
  ownerCliId: string | null = null
): ProjectConversationEntry {
  return {
    id: `${session.providerId}:${session.sessionId}`,
    providerId: session.providerId,
    ownerCliId,
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
  return [...conversations];
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
  const previewSource = getMessagePreviewText(latestUserMessage);

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
