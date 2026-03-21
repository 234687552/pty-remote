import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';

import type {
  GetOlderMessagesResultPayload,
  GetRuntimeSnapshotResultPayload,
  ListManagedPtyHandlesResultPayload,
  ListProjectSessionsResultPayload,
  ManagedPtyHandleSummary,
  PickProjectDirectoryResultPayload,
  ProjectSessionSummary,
  SelectConversationResultPayload,
  UploadAttachmentResultPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ChatAttachment } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import { PROVIDER_LABELS, type CliDescriptor, type ProviderId, type RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import type { CliSocketController } from '@/hooks/useCliSocket.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';
import { createEmptySnapshot } from '@/lib/runtime.ts';
import { readConversationCache } from '@/lib/messages-cache.ts';
import {
  clampSidebarToggleTop,
  createConversationFromSession,
  createDraftConversation,
  getProjectProviderKey,
  getThreadLabel,
  hydrateConversationFromSnapshot,
  sortConversations,
  sortProjects,
  type ProjectConversationEntry,
  type ProjectEntry
} from '@/lib/workspace.ts';

import { selectWorkspaceDerivedState } from './selectors.ts';
import type { WorkspaceStore } from './store.ts';
import type { ComposerAttachment } from './types.ts';

export interface ManagedPtyHandleView extends ManagedPtyHandleSummary {
  providerId: ProviderId;
  cliId: string;
  cliLabel: string;
  runtimeBackend: string;
  connected: boolean;
}

export interface WorkspaceController {
  activateConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => Promise<void>;
  addImageAttachments: (files: File[]) => Promise<void>;
  addProject: (input: { cwd: string; providerId: ProviderId }) => Promise<void>;
  createConversation: (project: ProjectEntry, providerId: ProviderId) => Promise<void>;
  deleteConversation: (project: ProjectEntry, providerId: ProviderId, conversation: ProjectConversationEntry) => Promise<void>;
  deleteProject: (project: ProjectEntry) => Promise<void>;
  importConversationFromSession: (providerId: ProviderId, session: ProjectSessionSummary) => Promise<void>;
  listRecentProjectSessions: (providerId: ProviderId, maxSessions?: number) => Promise<ProjectSessionSummary[]>;
  listManagedPtyHandles: () => Promise<ManagedPtyHandleView[]>;
  loadOlderMessages: (beforeMessageId: string | undefined) => Promise<boolean>;
  pickProjectDirectory: (providerId: ProviderId) => Promise<string | null>;
  removePendingAttachment: (localId: string) => Promise<void>;
  selectCli: (cliId: string | null) => void;
  selectProject: (project: ProjectEntry) => void;
  reorderConversation: (
    project: ProjectEntry,
    providerId: ProviderId,
    sourceConversationId: string,
    targetConversationId: string
  ) => Promise<void>;
  sendCommand: CliSocketController['sendCommand'];
  selectProvider: (project: ProjectEntry, providerId: ProviderId) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  stopMessage: () => Promise<void>;
  submitPrompt: (event: React.FormEvent) => Promise<void>;
}

interface UseWorkspaceControllerParams {
  clis: CliDescriptor[];
  requestMobilePaneScrollToBottom?: () => void;
  sendCommand: CliSocketController['sendCommand'];
  socketConnected: boolean;
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
const IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const IMAGE_MAX_DIMENSION = 1600;
const IMAGE_JPEG_QUALITY = 0.82;

function createAttachmentPreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.split(',')[1] ?? '';
      if (!base64) {
        reject(new Error('图片读取失败'));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('图片读取失败'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    image.src = url;
  });
}

async function compressImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= IMAGE_COMPRESSION_THRESHOLD_BYTES) {
    return file;
  }

  const image = await loadImageElement(file);
  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  if (!(scale < 1) && file.size <= IMAGE_COMPRESSION_THRESHOLD_BYTES) {
    return file;
  }

  const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('图片压缩失败');
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  const outputMimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const compressedBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('图片压缩失败'));
          return;
        }
        resolve(blob);
      },
      outputMimeType,
      outputMimeType === 'image/jpeg' ? IMAGE_JPEG_QUALITY : undefined
    );
  });

  if (compressedBlob.size >= file.size) {
    return file;
  }

  const nextName =
    outputMimeType === file.type
      ? file.name
      : file.name.replace(/\.[^.]+$/, outputMimeType === 'image/jpeg' ? '.jpg' : '.png');

  return new File([compressedBlob], nextName, {
    type: outputMimeType,
    lastModified: file.lastModified
  });
}

function revokeAttachmentPreview(attachment: Pick<ComposerAttachment, 'previewUrl'>): void {
  if (!attachment.previewUrl) {
    return;
  }
  URL.revokeObjectURL(attachment.previewUrl);
}

function buildPromptWithAttachmentPaths(text: string, attachments: ChatAttachment[]): string {
  const lines = attachments.map((attachment) => `@${attachment.path}`);
  const trimmedText = text.trim();
  if (trimmedText) {
    lines.push('', trimmedText);
  }
  return lines.join('\n').trim();
}

function supportsProvider(cli: CliDescriptor, providerId: ProviderId | null): boolean {
  return providerId !== null && cli.supportedProviders.includes(providerId);
}

function getCliRuntimeState(cli: CliDescriptor | null, providerId: ProviderId | null) {
  return providerId ? cli?.runtimes[providerId] ?? null : null;
}

function getConnectedCliForProvider(
  clis: CliDescriptor[],
  providerId: ProviderId | null,
  preferredCliId: string | null
): CliDescriptor | null {
  if (!providerId) {
    return null;
  }

  const candidates = clis.filter((cli) => cli.connected && supportsProvider(cli, providerId));
  if (candidates.length === 0) {
    return null;
  }

  return candidates.find((cli) => cli.cliId === preferredCliId) ?? candidates[0] ?? null;
}

export function useWorkspaceController({
  clis,
  requestMobilePaneScrollToBottom,
  sendCommand,
  socketConnected,
  store,
  terminal
}: UseWorkspaceControllerParams): WorkspaceController {
  const conversationActivationRef = useRef<
    { status: 'idle' } | { requestId: number; requestKey: string; requestToken: string; status: 'selecting' }
  >({ status: 'idle' });
  const conversationActivationSeqRef = useRef(0);
  const pendingAttachmentsRef = useRef(store.pendingAttachments);
  const sentAttachmentBindingsRef = useRef(store.sentAttachmentBindingsByConversationId);
  const sidebarToggleTopRef = useRef(store.sidebarToggleTop);

  const {
    activeCli,
    activeCliId,
    activeProject,
    activeProjectConversations,
    activeProviderId,
    activeConversation,
    visibleMessages
  } = useMemo(
    () => selectWorkspaceDerivedState(store, clis, socketConnected),
    [
      clis,
      socketConnected,
      store.olderMessages,
      store.projectConversationsByKey,
      store.snapshot,
      store.workspaceState
    ]
  );
  const activeCliConnected = Boolean(activeCli?.connected);

  pendingAttachmentsRef.current = store.pendingAttachments;
  sentAttachmentBindingsRef.current = store.sentAttachmentBindingsByConversationId;
  sidebarToggleTopRef.current = store.sidebarToggleTop;

  useEffect(() => {
    return () => {
      for (const attachment of pendingAttachmentsRef.current) {
        revokeAttachmentPreview(attachment);
      }
      for (const bindings of Object.values(sentAttachmentBindingsRef.current)) {
        for (const binding of bindings) {
          for (const attachment of binding.attachments) {
            revokeAttachmentPreview(attachment);
          }
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!activeConversation || !activeProviderId) {
      return;
    }
    if (
      store.snapshot.providerId === activeProviderId &&
      store.snapshot.conversationKey === activeConversation.conversationKey
    ) {
      return;
    }

    const cached = readConversationCache(
      activeProviderId,
      activeConversation.conversationKey,
      activeConversation.sessionId
    );
    if (!cached || cached.messages.length === 0) {
      return;
    }

    const cachedSnapshot: RuntimeSnapshot = {
      providerId: activeProviderId,
      conversationKey: activeConversation.conversationKey,
      sessionId: activeConversation.sessionId ?? cached.sessionId ?? null,
      status: 'idle',
      messages: cached.messages,
      hasOlderMessages: activeConversation.messageCount > cached.messages.length,
      lastError: null
    };
    store.setSnapshot(cachedSnapshot);
  }, [activeConversation, activeProviderId, store, store.snapshot.conversationKey, store.snapshot.providerId]);

  useEffect(() => {
    if (store.mobilePane === 'terminal') {
      terminal.scheduleResize();
    }
  }, [store.mobilePane, terminal]);

  useEffect(() => {
    const staleAttachments = store.pendingAttachments.filter((attachment) => attachment.conversationId !== activeConversation?.id);
    if (staleAttachments.length === 0) {
      return;
    }

    store.setPendingAttachments((current) => current.filter((attachment) => attachment.conversationId === activeConversation?.id));

    for (const attachment of staleAttachments) {
      revokeAttachmentPreview(attachment);
      if (attachment.status !== 'ready' || !attachment.attachmentId) {
        continue;
      }
      void sendCommand(
        'delete-attachment',
        {
          attachmentId: attachment.attachmentId
        },
        attachment.cliId,
        attachment.providerId
      ).catch(() => undefined);
    }
  }, [activeConversation?.id, sendCommand, store.pendingAttachments]);

  useEffect(() => {
    terminal.scheduleResize();
  }, [store.workspaceState.sidebarCollapsed, terminal]);

  useEffect(() => {
    const handleResize = () => {
      const nextTop = clampSidebarToggleTop(sidebarToggleTopRef.current, window.innerHeight);
      store.setSidebarToggleTop(nextTop);
      store.patchWorkspace((current) => {
        const clampedTop = clampSidebarToggleTop(current.sidebarToggleTop, window.innerHeight);
        return current.sidebarToggleTop === clampedTop ? current : { ...current, sidebarToggleTop: clampedTop };
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (clis.length === 0) {
      return;
    }

    const selectedCli = clis.find((cli) => cli.cliId === store.workspaceState.activeCliId && cli.connected) ?? null;
    const fallbackCli = selectedCli ?? clis.find((cli) => cli.connected) ?? null;
    if (!fallbackCli) {
      return;
    }

    store.patchWorkspace((current) => {
      const nextCliId = fallbackCli.cliId;
      const nextProviderId =
        current.activeProviderId && supportsProvider(fallbackCli, current.activeProviderId)
          ? current.activeProviderId
          : fallbackCli.supportedProviders[0] ?? null;
      if (current.activeCliId === nextCliId && current.activeProviderId === nextProviderId) {
        return current;
      }

      return {
        ...current,
        activeCliId: nextCliId,
        activeProviderId: nextProviderId
      };
    });
  }, [clis, store.workspaceState.activeCliId, store.workspaceState.activeProviderId]);

  useEffect(() => {
    const nextCli = getConnectedCliForProvider(clis, store.workspaceState.activeProviderId, store.workspaceState.activeCliId);
    if (!nextCli || nextCli.cliId === store.workspaceState.activeCliId) {
      return;
    }

    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextCli.cliId
    }));
  }, [clis, store.workspaceState.activeCliId, store.workspaceState.activeProviderId]);

  useEffect(() => {
    if (!activeProject || !activeProviderId || activeProjectConversations.length === 0 || activeConversation) {
      return;
    }

    store.patchWorkspace((current) =>
      current.activeProjectId === activeProject.id && current.activeProviderId === activeProviderId
        ? {
            ...current,
            activeConversationId: activeProjectConversations[0]?.id ?? null
          }
        : current
    );
  }, [activeConversation, activeProject, activeProjectConversations, activeProviderId]);

  useEffect(() => {
    if (!activeProject || !activeConversation || !activeCli || !activeProviderId) {
      return;
    }

    const activeRuntime = getCliRuntimeState(activeCli, activeProviderId);
    const backendMatchesProject = (activeRuntime?.cwd ?? activeCli.cwd) === activeProject.cwd;
    const canHydrateFromSnapshot =
      backendMatchesProject &&
      store.snapshot.providerId === activeProviderId &&
      store.snapshot.conversationKey === activeConversation.conversationKey;
    if (!canHydrateFromSnapshot) {
      return;
    }

    store.setProjectConversations(activeProject.id, activeProviderId, (conversations) => {
      let changed = false;
      const nextConversations = conversations.map((conversation) => {
        if (conversation.id !== activeConversation.id) {
          return conversation;
        }

        const nextConversation = {
          ...hydrateConversationFromSnapshot(conversation, store.snapshot, visibleMessages),
          ownerCliId: activeCli.cliId
        };
        const shouldUpdate =
          conversation.ownerCliId !== nextConversation.ownerCliId ||
          conversation.sessionId !== nextConversation.sessionId ||
          conversation.title !== nextConversation.title ||
          conversation.preview !== nextConversation.preview ||
          conversation.updatedAt !== nextConversation.updatedAt ||
          conversation.messageCount !== nextConversation.messageCount ||
          conversation.draft !== nextConversation.draft;

        if (!shouldUpdate) {
          return conversation;
        }

        changed = true;
        return nextConversation;
      });

      return changed ? nextConversations : conversations;
    });
  }, [
    activeCli,
    activeConversation,
    activeProject,
    activeProviderId,
    store,
    store.snapshot.conversationKey,
    store.snapshot.providerId,
    store.snapshot.sessionId,
    visibleMessages
  ]);

  useEffect(() => {
    if (!socketConnected || !activeCliId || !activeCliConnected) {
      store.resetRuntimeForCliChange();
      terminal.clearTerminal();
      return;
    }

    terminal.prepareForResume();
    store.resetRuntimeForCliChange();

      void sendCommand('get-runtime-snapshot', {}, activeCliId, activeProviderId)
      .then(async (result) => {
        const nextSnapshot = (result.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
        store.setSnapshot(nextSnapshot);
      })
      .catch((runtimeError) => {
        terminal.clearTerminal();
        store.setError(runtimeError instanceof Error ? runtimeError.message : '加载 CLI 运行态失败');
      });
  }, [activeCliConnected, activeCliId, activeProviderId, sendCommand, socketConnected, terminal]);

  useEffect(() => {
    if (!socketConnected || !activeCli?.connected || !activeProject || !activeConversation || !activeProviderId) {
      return;
    }

    const conversationKey = activeConversation.conversationKey;
    const requestKey = `${activeCli.cliId}:${activeProviderId}:${conversationKey}:${activeConversation.sessionId ?? 'draft'}`;
    const activeRuntime = getCliRuntimeState(activeCli, activeProviderId);
    const backendMatchesProject = (activeRuntime?.cwd ?? activeCli.cwd) === activeProject.cwd;
    const backendMatchesConversation =
      (store.snapshot.conversationKey ?? activeRuntime?.conversationKey ?? null) === conversationKey &&
      (store.snapshot.providerId ?? activeProviderId) === activeProviderId;
    const activationState = conversationActivationRef.current;

    if (backendMatchesProject && backendMatchesConversation) {
      if (activationState.status === 'selecting' && activationState.requestKey === requestKey) {
        conversationActivationRef.current = { status: 'idle' };
      }
      return;
    }

    if (activationState.status === 'selecting' && activationState.requestKey === requestKey) {
      return;
    }

    void activateConversation(activeProject, activeProviderId, activeConversation, { requestKey });
  }, [activeCli, activeConversation, activeProject, activeProviderId, socketConnected, store.snapshot.conversationKey, store.snapshot.providerId]);

  async function fetchProjectSessions(
    providerId: ProviderId,
    maxSessions: number,
    cliId = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId)?.cliId ?? null
  ): Promise<ListProjectSessionsResultPayload> {
    if (!cliId) {
      throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
    }

    const targetCli = clis.find((cli) => cli.cliId === cliId && cli.connected && supportsProvider(cli, providerId)) ?? null;
    if (!targetCli) {
      throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
    }

    const runtimeCwd = targetCli.runtimes[providerId]?.cwd?.trim();
    const fallbackCwd = runtimeCwd || activeProject?.cwd || targetCli.cwd;
    if (!fallbackCwd) {
      throw new Error('无法确定历史会话目录');
    }

    const result = await sendCommand(
      'list-project-conversations',
      { cwd: fallbackCwd, maxSessions },
      cliId,
      providerId
    );
    return (result.payload as ListProjectSessionsResultPayload | undefined) ?? {
      providerId,
      cwd: fallbackCwd,
      label: getThreadLabel(fallbackCwd),
      sessions: []
    };
  }

  async function listRecentProjectSessions(
    providerId: ProviderId,
    maxSessions = 10
  ): Promise<ProjectSessionSummary[]> {
    store.setError('');
    const result = await fetchProjectSessions(providerId, maxSessions);
    return result.sessions;
  }

  async function listManagedPtyHandles(): Promise<ManagedPtyHandleView[]> {
    store.setError('');
    const targets = clis.flatMap((cli) =>
      (cli.connected ? cli.supportedProviders : []).map((providerId) => ({
        cliId: cli.cliId,
        cliLabel: cli.label,
        runtimeBackend: cli.runtimeBackend,
        connected: cli.connected,
        providerId
      }))
    );

    if (targets.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const result = await sendCommand('list-managed-pty-handles', {}, target.cliId, target.providerId);
        const payload = (result.payload as ListManagedPtyHandlesResultPayload | undefined) ?? {
          providerId: target.providerId,
          handles: []
        };
        return payload.handles.map((handle) => ({
          ...handle,
          providerId: payload.providerId ?? target.providerId,
          cliId: target.cliId,
          cliLabel: target.cliLabel,
          runtimeBackend: target.runtimeBackend,
          connected: target.connected
        }));
      })
    );

    const merged: ManagedPtyHandleView[] = [];
    let firstError = '';
    for (const result of results) {
      if (result.status === 'fulfilled') {
        merged.push(...result.value);
        continue;
      }
      if (!firstError) {
        firstError = result.reason instanceof Error ? result.reason.message : '加载 PTY 列表失败';
      }
    }

    if (merged.length === 0 && firstError) {
      throw new Error(firstError);
    }

    return merged.sort((left, right) => {
      if (left.hasPty !== right.hasPty) {
        return left.hasPty ? -1 : 1;
      }
      const leftLastActivityAt = left.lastActivityAt ?? 0;
      const rightLastActivityAt = right.lastActivityAt ?? 0;
      if (leftLastActivityAt !== rightLastActivityAt) {
        return rightLastActivityAt - leftLastActivityAt;
      }
      if (left.providerId !== right.providerId) {
        return left.providerId.localeCompare(right.providerId);
      }
      return left.cliLabel.localeCompare(right.cliLabel) || left.conversationKey.localeCompare(right.conversationKey);
    });
  }

  async function activateConversation(
    project: ProjectEntry,
    providerId: ProviderId,
    conversation: ProjectConversationEntry,
    options?: { requestKey?: string; requestToken?: string }
  ): Promise<void> {
    let requestId: number | null = null;
    let requestToken: string | null = null;
    try {
      store.setError('');
      const ownerCliId = conversation.ownerCliId?.trim() ?? '';
      if (!ownerCliId) {
        throw new Error('会话缺少 ownerCliId，无法定位所属 CLI');
      }
      const targetCli =
        clis.find((cli) => cli.cliId === ownerCliId && cli.connected && supportsProvider(cli, providerId)) ?? null;
      if (!targetCli) {
        throw new Error(`会话所属 CLI 已离线或不支持 ${PROVIDER_LABELS[providerId]}（${ownerCliId}）`);
      }

      const requestKey =
        options?.requestKey ??
        `${targetCli.cliId}:${providerId}:${conversation.conversationKey}:${conversation.sessionId ?? 'draft'}`;
      requestToken = options?.requestToken ?? `select-${targetCli.cliId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      requestId = conversationActivationSeqRef.current + 1;
      conversationActivationSeqRef.current = requestId;
      conversationActivationRef.current = {
        status: 'selecting',
        requestId,
        requestKey,
        requestToken
      };

      if (conversation.sessionId === null) {
        store.resetRuntimeForDraftThread();
      }
      store.patchWorkspace((current) => ({
        ...current,
        activeCliId: targetCli.cliId,
        activeProjectId: project.id,
        activeProviderId: providerId,
        activeConversationId: conversation.id
      }));
      store.setProjectConversations(project.id, providerId, (conversations) =>
        conversations.map((entry) =>
          entry.id === conversation.id && entry.ownerCliId !== targetCli.cliId
            ? { ...entry, ownerCliId: targetCli.cliId }
            : entry
        )
      );

      const cached = readConversationCache(providerId, conversation.conversationKey, conversation.sessionId);
      if (cached && cached.messages.length > 0) {
        const cachedSnapshot: RuntimeSnapshot = {
          providerId,
          conversationKey: conversation.conversationKey,
          sessionId: conversation.sessionId ?? cached.sessionId ?? null,
          status: 'idle',
          messages: cached.messages,
          hasOlderMessages: conversation.messageCount > cached.messages.length,
          lastError: null
        };
        store.setSnapshot(cachedSnapshot);
      }

      const result = await sendCommand(
        'select-conversation',
        {
          cwd: project.cwd,
          conversationKey: conversation.conversationKey,
          sessionId: conversation.sessionId,
          clientRequestId: requestToken
        },
        targetCli.cliId,
        providerId
      );
      const selectPayload = result.payload as SelectConversationResultPayload | undefined;
      if (selectPayload?.sessionId) {
        store.setProjectConversations(project.id, providerId, (conversations) =>
          conversations.map((entry) =>
            entry.id === conversation.id
              ? {
                  ...entry,
                  ownerCliId: targetCli.cliId,
                  sessionId: selectPayload.sessionId,
                  draft: false
                }
              : entry
          )
        );
      }

      const runtimeSnapshotResult = await sendCommand('get-runtime-snapshot', {}, targetCli.cliId, providerId);
      const nextSnapshot =
        (runtimeSnapshotResult.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
      store.setSnapshot(nextSnapshot);

      const acknowledgedRequestToken = selectPayload?.clientRequestId ?? null;
      const activationState = conversationActivationRef.current;
      if (
        requestId !== null &&
        requestToken !== null &&
        activationState.status === 'selecting' &&
        activationState.requestId === requestId &&
        (acknowledgedRequestToken === null || acknowledgedRequestToken === requestToken)
      ) {
        conversationActivationRef.current = { status: 'idle' };
      }
      store.setMobilePane('chat');
    } catch (activateError) {
      const activationState = conversationActivationRef.current;
      if (
        requestId !== null &&
        requestToken !== null &&
        activationState.status === 'selecting' &&
        activationState.requestId === requestId &&
        activationState.requestToken === requestToken
      ) {
        conversationActivationRef.current = { status: 'idle' };
      }
      store.setError(activateError instanceof Error ? activateError.message : '切换 conversation 失败');
    }
  }

  async function addProject(input: { cwd: string; providerId: ProviderId }): Promise<void> {
    try {
      store.setError('');
      const normalizedCwd = input.cwd.trim();
      const selectedProviderId = input.providerId;
      if (!normalizedCwd) {
        throw new Error('目录路径不能为空');
      }

      const targetCli = getConnectedCliForProvider(clis, selectedProviderId, activeCliId);
      if (!targetCli) {
        throw new Error(`No connected CLI available for ${PROVIDER_LABELS[selectedProviderId]}`);
      }

      let selectedProject: ProjectEntry = {
        id: crypto.randomUUID(),
        cwd: normalizedCwd,
        label: getThreadLabel(normalizedCwd)
      };

      store.patchWorkspace((current) => {
        const existingProject = current.projects.find((project) => project.cwd === normalizedCwd);
        if (existingProject) {
          selectedProject = existingProject;
          const existingConversations =
            store.projectConversationsByKey[getProjectProviderKey(existingProject.id, selectedProviderId)] ?? [];
          return {
            ...current,
            activeCliId: targetCli.cliId,
            activeProjectId: existingProject.id,
            activeProviderId: selectedProviderId,
            activeConversationId: existingConversations[0]?.id ?? null
          };
        }

        return {
          ...current,
          activeCliId: targetCli.cliId,
          activeProjectId: selectedProject.id,
          activeProviderId: selectedProviderId,
          activeConversationId: null,
          projects: sortProjects([...current.projects, selectedProject])
        };
      });
    } catch (addProjectError) {
      const message = addProjectError instanceof Error ? addProjectError.message : '添加项目失败';
      store.setError(message);
      throw addProjectError instanceof Error ? addProjectError : new Error(message);
    }
  }

  async function createConversation(project: ProjectEntry, providerId: ProviderId): Promise<void> {
    try {
      store.setError('');
      const targetCli = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId);
      if (!targetCli) {
        throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
      }

      const nextConversation = createDraftConversation(providerId, targetCli.cliId);
      store.setProjectConversations(project.id, providerId, (conversations) =>
        sortConversations([nextConversation, ...conversations])
      );
      await activateConversation(project, providerId, nextConversation);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : '创建会话失败';
      store.setError(message);
      throw createError instanceof Error ? createError : new Error(message);
    }
  }

  async function addImageAttachments(files: File[]): Promise<void> {
    if (!activeCliId || !activeProject || !activeConversation || !activeProviderId) {
      store.setError('请先选择一个会话后再插入图片');
      return;
    }

    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      store.setError('只支持插入图片文件');
      return;
    }

    for (const originalFile of imageFiles) {
      let file = originalFile;
      try {
        file = await compressImageIfNeeded(originalFile);
      } catch (compressionError) {
        store.setError(compressionError instanceof Error ? compressionError.message : '图片压缩失败');
        continue;
      }

      if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
        store.setError('图片不能超过 4MB');
        continue;
      }

      const localId = crypto.randomUUID();
      const previewUrl = createAttachmentPreviewUrl(file);
      const draftAttachment: ComposerAttachment = {
        attachmentId: '',
        cliId: activeCliId,
        conversationId: activeConversation.id,
        filename: file.name,
        localId,
        mimeType: file.type || 'image/png',
        path: '',
        previewUrl,
        providerId: activeProviderId,
        size: file.size,
        status: 'uploading'
      };

      store.setPendingAttachments((current) => [...current, draftAttachment]);

      try {
        const contentBase64 = await fileToBase64(file);
        const result = await sendCommand(
          'upload-attachment',
          {
            contentBase64,
            conversationKey: activeConversation.conversationKey,
            cwd: activeProject.cwd,
            filename: file.name,
            mimeType: file.type || 'image/png',
            sessionId: activeConversation.sessionId ?? null,
            size: file.size
          },
          activeCliId,
          activeProviderId
        );
        const payload = result.payload as UploadAttachmentResultPayload | undefined;
        if (!payload?.attachmentId || !payload.path) {
          throw new Error('图片上传失败');
        }

        const attachmentStillTracked = pendingAttachmentsRef.current.some((attachment) => attachment.localId === localId);
        if (!attachmentStillTracked) {
          revokeAttachmentPreview(draftAttachment);
          await sendCommand(
            'delete-attachment',
            {
              attachmentId: payload.attachmentId
            },
            activeCliId,
            activeProviderId
          );
          continue;
        }

        store.setPendingAttachments((current) =>
          current.map((attachment) =>
            attachment.localId === localId
              ? {
                  ...attachment,
                  attachmentId: payload.attachmentId,
                  filename: payload.filename,
                  mimeType: payload.mimeType,
                  path: payload.path,
                  size: payload.size,
                  status: 'ready'
                }
              : attachment
          )
        );
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : '图片上传失败';
        const attachmentStillTracked = pendingAttachmentsRef.current.some((attachment) => attachment.localId === localId);
        if (!attachmentStillTracked) {
          revokeAttachmentPreview(draftAttachment);
          continue;
        }

        store.setPendingAttachments((current) =>
          current.map((attachment) =>
            attachment.localId === localId
              ? {
                  ...attachment,
                  error: message,
                  status: 'error'
                }
              : attachment
          )
        );
        store.setError(message);
      }
    }
  }

  async function removePendingAttachment(localId: string): Promise<void> {
    const targetAttachment = pendingAttachmentsRef.current.find((attachment) => attachment.localId === localId) ?? null;
    if (!targetAttachment) {
      return;
    }

    store.setPendingAttachments((current) => current.filter((attachment) => attachment.localId !== localId));
    revokeAttachmentPreview(targetAttachment);

    if (targetAttachment.status !== 'ready' || !targetAttachment.attachmentId) {
      return;
    }

    try {
      await sendCommand(
        'delete-attachment',
        {
          attachmentId: targetAttachment.attachmentId
        },
        targetAttachment.cliId,
        targetAttachment.providerId
      );
    } catch (deleteError) {
      store.setError(deleteError instanceof Error ? deleteError.message : '删除图片失败');
    }
  }

  async function deleteConversation(
    project: ProjectEntry,
    providerId: ProviderId,
    conversation: ProjectConversationEntry
  ): Promise<void> {
    try {
      store.setError('');
      const ownerCliId = conversation.ownerCliId?.trim() ?? '';
      const targetCli =
        ownerCliId.length > 0
          ? clis.find((cli) => cli.cliId === ownerCliId && cli.connected && supportsProvider(cli, providerId)) ?? null
          : null;
      if (targetCli) {
        await sendCommand(
          'cleanup-conversation',
          {
            cwd: project.cwd,
            conversationKey: conversation.conversationKey,
            sessionId: conversation.sessionId
          },
          targetCli.cliId,
          providerId
        );
      } else if (ownerCliId.length > 0) {
        throw new Error(`会话所属 CLI 已离线或不支持 ${PROVIDER_LABELS[providerId]}（${ownerCliId}）`);
      }

      const storageKey = getProjectProviderKey(project.id, providerId);
      const existingConversations = store.projectConversationsByKey[storageKey] ?? [];
      const nextConversations = existingConversations.filter((entry) => entry.id !== conversation.id);
      store.setProjectConversations(project.id, providerId, () => nextConversations);

      const deletingActiveConversation =
        store.workspaceState.activeProjectId === project.id &&
        store.workspaceState.activeProviderId === providerId &&
        store.workspaceState.activeConversationId === conversation.id;
      if (!deletingActiveConversation) {
        return;
      }

      const fallbackConversation = nextConversations[0] ?? null;
      if (!fallbackConversation) {
        store.patchWorkspace((current) =>
          current.activeProjectId === project.id &&
          current.activeProviderId === providerId &&
          current.activeConversationId === conversation.id
            ? {
                ...current,
                activeConversationId: null
              }
            : current
        );
        store.resetRuntimeForCliChange();
        terminal.clearTerminal();
        return;
      }

      await activateConversation(project, providerId, fallbackConversation);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : '删除会话失败';
      store.setError(message);
      throw deleteError instanceof Error ? deleteError : new Error(message);
    }
  }

  async function importConversationFromSession(providerId: ProviderId, session: ProjectSessionSummary): Promise<void> {
    try {
      store.setError('');
      const normalizedCwd = session.cwd?.trim();
      if (!normalizedCwd) {
        throw new Error('历史会话缺少目录信息');
      }

      const targetCli = getConnectedCliForProvider(clis, providerId, activeCliId);
      if (!targetCli) {
        throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
      }

      let project = store.workspaceState.projects.find((entry) => entry.cwd === normalizedCwd) ?? null;
      if (!project) {
        project = {
          id: crypto.randomUUID(),
          cwd: normalizedCwd,
          label: getThreadLabel(normalizedCwd)
        };
        const nextProject = project;
        store.patchWorkspace((current) => ({
          ...current,
          activeCliId: targetCli.cliId,
          activeProjectId: nextProject.id,
          activeProviderId: providerId,
          activeConversationId: null,
          projects: sortProjects([...current.projects, nextProject])
        }));
      } else {
        const nextProject = project;
        store.patchWorkspace((current) => ({
          ...current,
          activeCliId: targetCli.cliId,
          activeProjectId: nextProject.id,
          activeProviderId: providerId
        }));
      }

      const normalizedSession: ProjectSessionSummary = {
        ...session,
        providerId,
        cwd: normalizedCwd
      };
      const storageKey = getProjectProviderKey(project.id, providerId);
      const existingConversations = store.projectConversationsByKey[storageKey] ?? [];
      const targetConversation =
        existingConversations.find((entry) => entry.sessionId === normalizedSession.sessionId) ??
        createConversationFromSession(normalizedSession, targetCli.cliId);

      store.setProjectConversations(project.id, providerId, (conversations) => {
        const deduped = conversations.filter((entry) => entry.sessionId !== normalizedSession.sessionId);
        return sortConversations([{ ...targetConversation, ownerCliId: targetCli.cliId }, ...deduped]);
      });

      await activateConversation(project, providerId, targetConversation);
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : '导入会话失败';
      store.setError(message);
      throw importError instanceof Error ? importError : new Error(message);
    }
  }

  async function deleteProject(project: ProjectEntry): Promise<void> {
    try {
      store.setError('');
      const deletingActiveProject = store.workspaceState.activeProjectId === project.id;
      const providerIds = new Set<ProviderId>(['claude', 'codex']);

      for (const storageKey of Object.keys(store.projectConversationsByKey)) {
        if (!storageKey.startsWith(`${project.id}:`)) {
          continue;
        }
        providerIds.add(storageKey.split(':')[1] as ProviderId);
      }

      for (const providerId of providerIds) {
        const targetCli = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId);
        if (!targetCli) {
          continue;
        }
        await sendCommand(
          'cleanup-project',
          {
            cwd: project.cwd
          },
          targetCli.cliId,
          providerId
        );
      }

      for (const providerId of providerIds) {
        store.setProjectConversations(project.id, providerId, () => []);
      }

      store.patchWorkspace((current) => {
        const nextProjects = sortProjects(current.projects.filter((entry) => entry.id !== project.id));
        if (current.activeProjectId !== project.id) {
          return {
            ...current,
            projects: nextProjects
          };
        }

        const fallbackProject = nextProjects[0] ?? null;
        return {
          ...current,
          projects: nextProjects,
          activeProjectId: fallbackProject?.id ?? null,
          activeProviderId: fallbackProject ? current.activeProviderId : null,
          activeConversationId: null
        };
      });

      if (deletingActiveProject) {
        store.resetRuntimeForCliChange();
        terminal.clearTerminal();
      }
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : '删除目录失败';
      store.setError(message);
      throw deleteError instanceof Error ? deleteError : new Error(message);
    }
  }

  async function pickProjectDirectory(providerId: ProviderId): Promise<string | null> {
    const targetCli = getConnectedCliForProvider(clis, providerId, activeCliId);
    if (!targetCli) {
      throw new Error(`No connected CLI available for ${PROVIDER_LABELS[providerId]}`);
    }

    const result = await sendCommand('pick-project-directory', {}, targetCli.cliId, providerId);
    const payload = result.payload as PickProjectDirectoryResultPayload | undefined;
    return payload?.cwd?.trim() || null;
  }

  function selectCli(nextCliId: string | null): void {
    const nextCli = clis.find((cli) => cli.cliId === nextCliId) ?? null;
    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: nextCliId,
      activeProviderId:
        nextCli && current.activeProviderId && supportsProvider(nextCli, current.activeProviderId)
          ? current.activeProviderId
          : nextCli?.supportedProviders[0] ?? current.activeProviderId,
      activeConversationId:
        nextCli && current.activeProviderId && !supportsProvider(nextCli, current.activeProviderId)
          ? null
          : current.activeConversationId
    }));
  }

  function selectProject(project: ProjectEntry): void {
    store.patchWorkspace((current) => ({
      ...current,
      activeProjectId: project.id
    }));
  }

  async function reorderConversation(
    project: ProjectEntry,
    providerId: ProviderId,
    sourceConversationId: string,
    targetConversationId: string
  ): Promise<void> {
    if (!sourceConversationId || !targetConversationId || sourceConversationId === targetConversationId) {
      return;
    }

    store.setProjectConversations(project.id, providerId, (conversations) => {
      const sourceIndex = conversations.findIndex((entry) => entry.id === sourceConversationId);
      const targetIndex = conversations.findIndex((entry) => entry.id === targetConversationId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return conversations;
      }

      const next = [...conversations];
      const [moved] = next.splice(sourceIndex, 1);
      if (!moved) {
        return conversations;
      }
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function selectProvider(project: ProjectEntry, providerId: ProviderId): void {
    const targetCli = getConnectedCliForProvider(clis, providerId, store.workspaceState.activeCliId);
    const conversations = store.projectConversationsByKey[getProjectProviderKey(project.id, providerId)] ?? [];

    store.patchWorkspace((current) => ({
      ...current,
      activeCliId: targetCli?.cliId ?? current.activeCliId,
      activeProjectId: project.id,
      activeProviderId: providerId,
      activeConversationId:
        current.activeProjectId === project.id && current.activeProviderId === providerId
          ? current.activeConversationId
          : conversations[0]?.id ?? null
    }));
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    store.patchWorkspace((current) => ({ ...current, sidebarCollapsed: collapsed }));
  }

  async function submitPrompt(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!activeCliId || !activeProject || !activeConversation || !activeProviderId) {
      store.setError('请先在侧边栏选择一个 project / provider / conversation');
      return;
    }

    const pendingAttachments = store.pendingAttachments.filter((attachment) => attachment.conversationId === activeConversation.id);
    if (pendingAttachments.some((attachment) => attachment.status !== 'ready')) {
      store.setError('请先等待图片上传完成');
      return;
    }

    const readyAttachments: ChatAttachment[] = pendingAttachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      path: attachment.path,
      previewUrl: attachment.previewUrl,
      size: attachment.size
    }));
    const rawText = store.prompt.trim();
    const content = buildPromptWithAttachmentPaths(rawText, readyAttachments);
    if (!content) {
      store.setError('请输入消息');
      return;
    }

    try {
      store.setError('');
      await sendCommand('send-message', { content }, activeCliId, activeProviderId);
      if (readyAttachments.length > 0) {
        store.setSentAttachmentBindings(activeConversation.id, (current) => [
          ...current,
          {
            attachments: readyAttachments,
            composedContent: content,
            conversationId: activeConversation.id,
            createdAt: new Date().toISOString(),
            displayText: rawText,
            id: crypto.randomUUID()
          }
        ]);
      }
      store.setPendingAttachments((current) =>
        current.filter((attachment) => attachment.conversationId !== activeConversation.id)
      );
      store.setPrompt('');
      requestMobilePaneScrollToBottom?.();
    } catch (submitError) {
      store.setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function stopMessage(): Promise<void> {
    if (!activeCliId) {
      return;
    }
    try {
      store.setError('');
      await sendCommand('stop-message', {}, activeCliId, activeProviderId);
    } catch (stopError) {
      store.setError(stopError instanceof Error ? stopError.message : '结束失败');
    }
  }

  async function loadOlderMessages(beforeMessageId: string | undefined): Promise<boolean> {
    try {
      store.setError('');
      store.setOlderMessagesLoading(true);

      const result = await sendCommand('get-older-messages', {
        beforeMessageId,
        maxMessages: 40
      }, undefined, activeProviderId);
      const payload = result.payload as GetOlderMessagesResultPayload | undefined;

      if (
        (payload?.providerId ?? null) !== store.snapshot.providerId ||
        (payload?.conversationKey ?? null) !== store.snapshot.conversationKey
      ) {
        return false;
      }

      store.mergeOlderMessages(payload?.messages ?? [], Boolean(payload?.hasOlderMessages));
      return Boolean(payload?.messages?.length);
    } catch (loadError) {
      store.setError(loadError instanceof Error ? loadError.message : '加载更早消息失败');
      return false;
    } finally {
      store.setOlderMessagesLoading(false);
    }
  }

  return {
    activateConversation,
    addImageAttachments,
    addProject,
    createConversation,
    deleteConversation,
    deleteProject,
    importConversationFromSession,
    listManagedPtyHandles,
    listRecentProjectSessions,
    loadOlderMessages,
    pickProjectDirectory,
    removePendingAttachment,
    reorderConversation,
    sendCommand,
    selectCli,
    selectProject,
    selectProvider,
    setSidebarCollapsed,
    stopMessage,
    submitPrompt
  };
}
