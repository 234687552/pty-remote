import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { AppShell } from '@/app-shell/AppShell.tsx';
import { ChatFeature } from '@/features/chat/ChatFeature.tsx';
import { ComposerFeature } from '@/features/composer/ComposerFeature.tsx';
import { HeaderFeature } from '@/features/header/HeaderFeature.tsx';
import { SidebarFeature } from '@/features/sidebar/SidebarFeature.tsx';
import { TerminalFeature } from '@/features/terminal/TerminalFeature.tsx';
import { useWorkspaceController } from '@/features/workspace/controller.ts';
import { selectActiveCliId, selectActiveProviderId } from '@/features/workspace/selectors.ts';
import { useWorkspaceStore } from '@/features/workspace/store.ts';
import { useCliSocket } from '@/hooks/useCliSocket.ts';
import { useTerminalBridge } from '@/hooks/useTerminalBridge.ts';
import { getProjectProviderKey } from '@/lib/workspace.ts';
import { applyCachedMessagesUpsert, readCachedLastSeq, updateCachedLastSeq, writeConversationCache } from '@/lib/messages-cache.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';
export function App() {
  const store = useWorkspaceStore();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileJumpControls, setMobileJumpControls] = useState<MobileJumpControls | null>(null);
  const [mobilePaneScrollRequests, setMobilePaneScrollRequests] = useState({
    chat: 0,
    terminal: 0
  });
  const [desktopTerminalVisible, setDesktopTerminalVisible] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches
  );
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
  const terminalVisible = desktopTerminalVisible || store.mobilePane === 'terminal';
  const socketRef = useRef<Socket | null>(null);
  const lastTerminalSyncKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(min-width: 1024px)');
    const handleChange = (event: MediaQueryListEvent) => {
      setDesktopTerminalVisible(event.matches);
    };

    setDesktopTerminalVisible(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

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

  const controller = useWorkspaceController({
    clis,
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
          clis={clis}
          onSidebarToggle={handleDesktopSidebarToggle}
          sidebarCollapsed={store.workspaceState.sidebarCollapsed}
          store={store}
        />
      )}
      chat={
        <ChatFeature
          clis={clis}
          onMobileJumpControlsChange={setMobileJumpControls}
          paneVisible={desktopTerminalVisible || store.mobilePane === 'chat'}
          scrollToBottomRequestKey={mobilePaneScrollRequests.chat}
          socketConnected={socketConnected}
          store={store}
        />
      }
      terminal={
        <TerminalFeature
          onMobileJumpControlsChange={setMobileJumpControls}
          scrollToBottomRequestKey={mobilePaneScrollRequests.terminal}
          store={store}
          terminal={terminal}
        />
      }
      composer={
        <ComposerFeature
          clis={clis}
          controller={controller}
          jumpControls={mobileJumpControls}
          mobilePane={store.mobilePane}
          mobileSidebarOpen={mobileSidebarOpen}
          onMobilePaneChange={store.setMobilePane}
          onSidebarOpen={handleMobileSidebarOpen}
          socketConnected={socketConnected}
          store={store}
          terminal={terminal}
        />
      }
    />
  );
}
