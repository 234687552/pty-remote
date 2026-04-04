import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { AppShell } from '@/app-shell/AppShell.tsx';
import { AppHeader } from '@/components/AppHeader.tsx';
import { ChatPane } from '@/components/ChatPane.tsx';
import { DesktopWorkspaceBrowser } from '@/components/DesktopWorkspaceBrowser.tsx';
import { Sidebar } from '@/components/Sidebar.tsx';
import { TerminalPane } from '@/components/TerminalPane.tsx';
import { ComposerFeature } from '@/features/composer/ComposerFeature.tsx';
import { useWorkspaceController } from '@/features/workspace/controller.ts';
import {
  selectActiveCliId,
  selectActiveProviderId,
  selectComposerViewModel,
  selectHeaderSummary,
  selectMobileProjectTitle,
  selectWorkspaceDerivedState
} from '@/features/workspace/selectors.ts';
import { useWorkspaceStore } from '@/features/workspace/store.ts';
import { useCliSocket } from '@/hooks/useCliSocket.ts';
import { useTerminalBridge } from '@/hooks/useTerminalBridge.ts';
import { getProjectProviderKey } from '@/lib/workspace.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';
import type { RuntimeRequestPayload } from '@lzdi/pty-remote-protocol/protocol.ts';

export function App() {
  const store = useWorkspaceStore();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileJumpControlsByPane, setMobileJumpControlsByPane] = useState<{
    chat: MobileJumpControls | null;
    terminal: MobileJumpControls | null;
  }>({
    chat: null,
    terminal: null
  });
  const [mobilePaneScrollRequests, setMobilePaneScrollRequests] = useState({
    chat: 0,
    terminal: 0
  });
  const [isDesktopLayout, setIsDesktopLayout] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches
  );
  const [desktopTerminalOpen, setDesktopTerminalOpen] = useState(false);
  const [desktopWorkspaceBrowserOpen, setDesktopWorkspaceBrowserOpen] = useState(false);
  const activeCliId = selectActiveCliId(store.workspaceState);
  const activeProviderId = selectActiveProviderId(store.workspaceState);
  const activeProjectId = store.workspaceState.activeProjectId;
  const activeConversationId = store.workspaceState.activeConversationId;
  const activeConversationKeyStorageKey =
    activeProjectId && activeProviderId ? getProjectProviderKey(activeProjectId, activeProviderId) : null;
  const activeConversation =
    activeConversationId && activeConversationKeyStorageKey
      ? (store.projectConversationsByKey[activeConversationKeyStorageKey] ?? []).find(
          (conversation) => conversation.id === activeConversationId
        ) ?? null
      : null;
  const activeConversationKey = activeConversation?.conversationKey ?? null;
  const activeSessionId = activeConversation?.sessionId ?? null;
  const mobileJumpControls = mobileJumpControlsByPane[store.mobilePane];
  const socketRef = useRef<Socket | null>(null);
  const lastTerminalSyncKeyRef = useRef<string | null>(null);
  const [runtimeRequests, setRuntimeRequests] = useState<RuntimeRequestPayload[]>([]);
  const terminalConnectionEnabled = Boolean(activeCliId && activeProviderId && activeConversation);

  const handleChatMobileJumpControlsChange = useCallback((controls: MobileJumpControls | null) => {
    setMobileJumpControlsByPane((current) => ({
      ...current,
      chat: controls
    }));
  }, []);

  const handleTerminalMobileJumpControlsChange = useCallback((controls: MobileJumpControls | null) => {
    setMobileJumpControlsByPane((current) => ({
      ...current,
      terminal: controls
    }));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(min-width: 1024px)');
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopLayout(event.matches);
      if (!event.matches) {
        setDesktopWorkspaceBrowserOpen(false);
      }
    };

    setIsDesktopLayout(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  const desktopPrimaryWorkspaceVisible = isDesktopLayout && !desktopWorkspaceBrowserOpen;
  const terminalPaneOpen = isDesktopLayout ? desktopTerminalOpen : store.mobilePane === 'terminal';
  const terminalVisible = terminalPaneOpen && (desktopPrimaryWorkspaceVisible || !isDesktopLayout);
  const chatPaneVisible = desktopPrimaryWorkspaceVisible || (!isDesktopLayout && store.mobilePane === 'chat');

  const terminal = useTerminalBridge({
    activeCliId,
    activeProviderId,
    socketRef,
    setError: store.setError,
    terminalEnabled: terminalConnectionEnabled,
    terminalVisible
  });

  const { socketConnected, clis, sendCommand, sendRuntimeRequestResponse } = useCliSocket({
    activeCliId,
    activeProviderId,
    activeConversationKey,
    activeSessionId,
    terminalEnabled: terminalConnectionEnabled,
    socketRef,
    onConnect: () => {
      terminal.handleSocketConnected();
      store.setError('');
    },
    onDisconnect: () => {
      terminal.handleSocketDisconnected();
    },
    onMessageDelta: (payload) => {
      store.applyMessageDelta(payload);
    },
    onMessagesUpsert: (payload) => {
      store.applyMessagesUpsert(payload);
    },
    onSnapshot: (nextSnapshot) => {
      store.setSnapshot(nextSnapshot);
    },
    onTerminalFramePatch: (payload) => {
      terminal.handleTerminalFramePatch(payload);
    },
    onRuntimeRequest: (payload) => {
      setRuntimeRequests((current) => {
        const next = current.filter((entry) => entry.requestId !== payload.requestId);
        next.push(payload);
        return next;
      });
    },
    onRuntimeRequestResolved: (payload) => {
      setRuntimeRequests((current) => current.filter((entry) => entry.requestId !== payload.requestId));
    }
  });
  const activeCli = activeCliId ? clis.find((cli) => cli.cliId === activeCliId) ?? null : null;
  const activeRuntime = activeProviderId ? activeCli?.runtimes[activeProviderId] ?? null : null;
  const terminalSupported = activeProviderId ? activeRuntime?.supportsTerminal !== false : false;
  const terminalSyncEnabled = terminalConnectionEnabled && terminalSupported;
  const workspaceDerivedState = useMemo(
    () => selectWorkspaceDerivedState(store, clis, socketConnected),
    [
      clis,
      socketConnected,
      store.pendingAttachments,
      store.projectConversationsByKey,
      store.prompt,
      store.sentAttachmentBindingsByConversationId,
      store.snapshot,
      store.workspaceState
    ]
  );
  const headerSummary = useMemo(() => selectHeaderSummary(workspaceDerivedState), [workspaceDerivedState]);
  const mobileProjectTitle = useMemo(() => selectMobileProjectTitle(workspaceDerivedState), [workspaceDerivedState]);
  const composerViewModel = useMemo(
    () => selectComposerViewModel(store, workspaceDerivedState, socketConnected),
    [socketConnected, store.error, store.snapshot, workspaceDerivedState]
  );
  const canSendApprovalInput = Boolean(
    workspaceDerivedState.activeCliId && workspaceDerivedState.activeProviderId && workspaceDerivedState.connected
  );
  const activeRuntimeRequests = useMemo(
    () =>
      runtimeRequests.filter(
        (request) =>
          request.cliId === activeCliId &&
          request.providerId === activeProviderId &&
          (!activeConversationKey || request.conversationKey === activeConversationKey)
      ),
    [activeCliId, activeConversationKey, activeProviderId, runtimeRequests]
  );
  const desktopWorkspaceBrowserEnabled = Boolean(
    workspaceDerivedState.activeProject?.cwd && workspaceDerivedState.activeCliId && workspaceDerivedState.connected
  );

  const controller = useWorkspaceController({
    clis,
    derivedState: workspaceDerivedState,
    requestMobilePaneScrollToBottom: () => {
      if (isDesktopLayout) {
        return;
      }

      setMobilePaneScrollRequests((current) => ({
        ...current,
        [store.mobilePane]: current[store.mobilePane] + 1
      }));
    },
    sendCommand,
    socketConnected,
    store,
    terminal
  });

  useEffect(() => {
    if (!desktopWorkspaceBrowserEnabled) {
      setDesktopWorkspaceBrowserOpen(false);
    }
  }, [desktopWorkspaceBrowserEnabled]);

  useEffect(() => {
    if (terminalSupported) {
      return;
    }
    setDesktopTerminalOpen(false);
  }, [terminalSupported]);

  useEffect(() => {
    if (!desktopWorkspaceBrowserOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDesktopWorkspaceBrowserOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [desktopWorkspaceBrowserOpen]);

  useEffect(() => {
    if (terminalSupported || store.mobilePane !== 'terminal') {
      return;
    }
    store.setMobilePane('chat');
  }, [store, store.mobilePane, terminalSupported]);

  useEffect(() => {
    if (terminalSyncEnabled) {
      return;
    }
    lastTerminalSyncKeyRef.current = null;
    terminal.clearTerminal();
  }, [terminal, terminalSyncEnabled]);

  useEffect(() => {
    if (!terminalSyncEnabled || !socketConnected || !activeCliId || !activeProviderId || !activeConversation) {
      lastTerminalSyncKeyRef.current = null;
      return;
    }
    if (
      store.snapshot.providerId !== activeProviderId ||
      store.snapshot.conversationKey !== activeConversation.conversationKey
    ) {
      return;
    }
    if (
      activeRuntime?.conversationKey !== activeConversation.conversationKey ||
      (activeSessionId !== null && activeRuntime?.sessionId !== activeSessionId)
    ) {
      lastTerminalSyncKeyRef.current = null;
      return;
    }

    const nextTerminalKey = `${activeCliId}:${activeProviderId}:${activeConversation.conversationKey}:${activeSessionId ?? ''}`;
    if (lastTerminalSyncKeyRef.current === nextTerminalKey) {
      return;
    }
    lastTerminalSyncKeyRef.current = nextTerminalKey;

    void terminal.resumeSession(activeSessionId ?? null, { force: true }).catch((error) => {
      lastTerminalSyncKeyRef.current = null;
      store.setError(error instanceof Error ? error.message : '终端帧同步失败');
    });
  }, [
    activeCliId,
    activeConversation,
    activeProviderId,
    activeRuntime?.conversationKey,
    activeRuntime?.sessionId,
    activeSessionId,
    socketConnected,
    store.snapshot.conversationKey,
    store.snapshot.providerId,
    store.setError,
    terminal,
    terminalSyncEnabled,
    terminalSupported,
    terminalVisible
  ]);

  function handleMobileSidebarOpen(): void {
    setMobileSidebarOpen(true);
  }

  function handleDesktopSidebarToggle(): void {
    controller.setSidebarCollapsed(!store.workspaceState.sidebarCollapsed);
  }

  function handleDesktopTerminalToggle(): void {
    if (!terminalSupported) {
      return;
    }
    if (desktopWorkspaceBrowserOpen) {
      setDesktopWorkspaceBrowserOpen(false);
    }
    setDesktopTerminalOpen((current) => !current);
  }

  return (
    <AppShell
      sidebar={
        <Sidebar
          activeCliId={store.workspaceState.activeCliId}
          activeConversationId={store.workspaceState.activeConversationId}
          activeProjectId={store.workspaceState.activeProjectId}
          activeProviderId={store.workspaceState.activeProviderId}
          clis={clis}
          collapsed={store.workspaceState.sidebarCollapsed}
          mobileOpen={mobileSidebarOpen}
          onActivateConversation={(project, providerId, conversation) => {
            void controller.activateConversation(project, providerId, conversation);
          }}
          onAddProject={controller.addProject}
          onCreateConversation={controller.createConversation}
          onDeleteConversation={(project, providerId, conversation) =>
            controller.deleteConversation(project, providerId, conversation)
          }
          onDeleteProject={controller.deleteProject}
          onImportConversationFromSession={controller.importConversationFromSession}
          onListManagedPtyHandles={controller.listManagedPtyHandles}
          onListRecentProjectSessions={(providerId, maxSessions) => controller.listRecentProjectSessions(providerId, maxSessions)}
          onMobileOpenChange={setMobileSidebarOpen}
          onPickProjectDirectory={controller.pickProjectDirectory}
          onRefreshConversation={(project, providerId, conversation) =>
            controller.refreshConversation(project, providerId, conversation)
          }
          onSelectCli={controller.selectCli}
          onSelectProject={controller.selectProject}
          projectConversationsByKey={store.projectConversationsByKey}
          projects={store.workspaceState.projects}
        />
      }
      renderHeader={() => (
        <AppHeader
          activeProviderId={workspaceDerivedState.activeProviderId}
          desktopTerminalEnabled={terminalSupported}
          desktopTerminalOpen={desktopTerminalOpen}
          desktopWorkspaceBrowserEnabled={desktopWorkspaceBrowserEnabled}
          desktopWorkspaceBrowserOpen={desktopWorkspaceBrowserOpen}
          onDesktopTerminalToggle={handleDesktopTerminalToggle}
          onDesktopWorkspaceBrowserToggle={() => {
            if (!desktopWorkspaceBrowserEnabled) {
              return;
            }
            setDesktopWorkspaceBrowserOpen((current) => !current);
          }}
          onSidebarToggle={handleDesktopSidebarToggle}
          sidebarCollapsed={store.workspaceState.sidebarCollapsed}
          summary={headerSummary}
        />
      )}
      chat={
        <ChatPane
          activeProviderId={workspaceDerivedState.activeProviderId}
          canSendApprovalInput={canSendApprovalInput}
          connected={workspaceDerivedState.connected}
          conversationScrollKey={
            workspaceDerivedState.activeConversation
              ? `${workspaceDerivedState.activeProviderId ?? 'unknown'}:${workspaceDerivedState.activeConversation.conversationKey}`
              : null
          }
          frameSnapshot={terminal.frameSnapshot}
          messages={workspaceDerivedState.visibleMessages}
          onMobileJumpControlsChange={handleChatMobileJumpControlsChange}
          onApprovalInput={terminal.sendInput}
          onRespondRuntimeRequest={async (payload) => {
            const result = await sendRuntimeRequestResponse(
              {
                ...payload,
                targetProviderId: activeProviderId
              },
              activeCliId
            );
            if (!result.ok) {
              throw new Error(result.error || 'Failed to respond to runtime request');
            }
          }}
          paneVisible={chatPaneVisible}
          runtimeRequests={activeRuntimeRequests}
          scrollToBottomRequestKey={mobilePaneScrollRequests.chat}
          transientNotice={store.snapshot.transientNotice}
          visible={store.mobilePane === 'chat'}
        />
      }
      terminal={
        terminalSupported && terminalPaneOpen ? (
          <TerminalPane
            frameSnapshot={terminal.frameSnapshot}
            hostRef={terminal.terminalHostRef}
            onJumpToEdge={terminal.jumpToEdge}
            onMobileJumpControlsChange={handleTerminalMobileJumpControlsChange}
            scrollToBottomRequestKey={mobilePaneScrollRequests.terminal}
            viewportRef={terminal.terminalViewportRef}
            visible={terminalVisible}
          />
        ) : null
      }
      workspaceBrowser={
        <DesktopWorkspaceBrowser
          activeCliId={workspaceDerivedState.activeCliId}
          activeProviderId={workspaceDerivedState.activeProviderId}
          projectCwd={workspaceDerivedState.activeProject?.cwd ?? null}
          projectLabel={workspaceDerivedState.activeProject?.label ?? '当前目录'}
          sendCommand={controller.sendCommand}
          setPrompt={store.setPrompt}
          visible={desktopWorkspaceBrowserOpen}
        />
      }
      workspaceBrowserOpen={desktopWorkspaceBrowserOpen}
      composer={
        <ComposerFeature
          controller={controller}
          derivedState={workspaceDerivedState}
          jumpControls={mobileJumpControls}
          mobilePane={store.mobilePane}
          mobileProjectTitle={mobileProjectTitle}
          mobileSidebarOpen={mobileSidebarOpen}
          onMobilePaneChange={store.setMobilePane}
          onSidebarOpen={handleMobileSidebarOpen}
          store={store}
          terminalSupported={terminalSupported}
          terminal={terminal}
          viewModel={composerViewModel}
        />
      }
    />
  );
}
