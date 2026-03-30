import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { AppShell } from '@/app-shell/AppShell.tsx';
import { DesktopWorkspaceBrowser } from '@/components/DesktopWorkspaceBrowser.tsx';
import { ChatFeature } from '@/features/chat/ChatFeature.tsx';
import { ComposerFeature } from '@/features/composer/ComposerFeature.tsx';
import { HeaderFeature } from '@/features/header/HeaderFeature.tsx';
import { SidebarFeature } from '@/features/sidebar/SidebarFeature.tsx';
import { TerminalFeature } from '@/features/terminal/TerminalFeature.tsx';
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
import { applyCachedMessagesUpsert, readCachedLastSeq, updateCachedLastSeq, writeConversationCache } from '@/lib/messages-cache.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';
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
  const [desktopTerminalVisible, setDesktopTerminalVisible] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches
  );
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
  const isDesktopLayout = desktopTerminalVisible;
  const socketRef = useRef<Socket | null>(null);
  const lastTerminalSyncKeyRef = useRef<string | null>(null);

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
      setDesktopTerminalVisible(event.matches);
      if (!event.matches) {
        setDesktopWorkspaceBrowserOpen(false);
      }
    };

    setDesktopTerminalVisible(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  const desktopPrimaryWorkspaceVisible = isDesktopLayout && !desktopWorkspaceBrowserOpen;
  const terminalVisible = desktopPrimaryWorkspaceVisible || (!isDesktopLayout && store.mobilePane === 'terminal');
  const chatPaneVisible = desktopPrimaryWorkspaceVisible || (!isDesktopLayout && store.mobilePane === 'chat');

  const terminal = useTerminalBridge({
    activeCliId,
    activeProviderId,
    socketRef,
    setError: store.setError,
    terminalVisible
  });

  const { socketConnected, clis, sendCommand } = useCliSocket({
    activeCliId,
    activeProviderId,
    activeConversationKey,
    activeSessionId,
    terminalEnabled: terminalVisible,
    socketRef,
    onConnect: () => {
      terminal.handleSocketConnected();
      store.setError('');
    },
    onDisconnect: () => {
      terminal.handleSocketDisconnected();
    },
    onMessagesUpsert: (payload) => {
      store.applyMessagesUpsert(payload);
      applyCachedMessagesUpsert(payload);
      if (payload.seq != null) {
        updateCachedLastSeq(payload.providerId ?? null, payload.conversationKey ?? null, payload.sessionId ?? null, payload.seq);
      }
    },
    onSnapshot: (nextSnapshot) => {
      store.setSnapshot(nextSnapshot);
      if (nextSnapshot.providerId) {
        const lastSeq = readCachedLastSeq(
          nextSnapshot.providerId,
          nextSnapshot.conversationKey ?? null,
          nextSnapshot.sessionId ?? null
        );
        writeConversationCache({
          providerId: nextSnapshot.providerId,
          conversationKey: nextSnapshot.conversationKey ?? null,
          sessionId: nextSnapshot.sessionId ?? null,
          messages: nextSnapshot.messages,
          lastSeq
        });
      }
    },
    onTerminalFramePatch: (payload) => {
      terminal.handleTerminalFramePatch(payload);
    }
  });
  const activeCli = activeCliId ? clis.find((cli) => cli.cliId === activeCliId) ?? null : null;
  const activeRuntime = activeProviderId ? activeCli?.runtimes[activeProviderId] ?? null : null;
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
  const desktopWorkspaceBrowserEnabled = Boolean(
    workspaceDerivedState.activeProject?.cwd && workspaceDerivedState.activeCliId && workspaceDerivedState.connected
  );

  const controller = useWorkspaceController({
    clis,
    derivedState: workspaceDerivedState,
    requestMobilePaneScrollToBottom: () => {
      if (desktopTerminalVisible) {
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
    if (!terminalVisible || !socketConnected || !activeCliId || !activeProviderId || !activeConversation) {
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
    terminalVisible
  ]);

  function handleMobileSidebarOpen(): void {
    setMobileSidebarOpen(true);
  }

  function handleDesktopSidebarToggle(): void {
    controller.setSidebarCollapsed(!store.workspaceState.sidebarCollapsed);
  }

  return (
    <AppShell
      sidebar={<SidebarFeature clis={clis} controller={controller} mobileOpen={mobileSidebarOpen} onMobileOpenChange={setMobileSidebarOpen} store={store} />}
      renderHeader={() => (
        <HeaderFeature
          activeProviderId={workspaceDerivedState.activeProviderId}
          desktopWorkspaceBrowserEnabled={desktopWorkspaceBrowserEnabled}
          desktopWorkspaceBrowserOpen={desktopWorkspaceBrowserOpen}
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
        <ChatFeature
          derivedState={workspaceDerivedState}
          onMobileJumpControlsChange={handleChatMobileJumpControlsChange}
          paneVisible={chatPaneVisible}
          scrollToBottomRequestKey={mobilePaneScrollRequests.chat}
          store={store}
          terminal={terminal}
        />
      }
      terminal={
        <TerminalFeature
          onMobileJumpControlsChange={handleTerminalMobileJumpControlsChange}
          scrollToBottomRequestKey={mobilePaneScrollRequests.terminal}
          store={store}
          terminal={terminal}
        />
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
          terminal={terminal}
          viewModel={composerViewModel}
        />
      }
    />
  );
}
