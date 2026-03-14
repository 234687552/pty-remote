import { useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { AppShell } from '@/app-shell/AppShell.tsx';
import { ChatFeature } from '@/features/chat/ChatFeature.tsx';
import { ComposerFeature } from '@/features/composer/ComposerFeature.tsx';
import { HeaderFeature } from '@/features/header/HeaderFeature.tsx';
import { SidebarFeature } from '@/features/sidebar/SidebarFeature.tsx';
import { TerminalFeature } from '@/features/terminal/TerminalFeature.tsx';
import { useWorkspaceController } from '@/features/workspace/controller.ts';
import { selectActiveCliId } from '@/features/workspace/selectors.ts';
import { useWorkspaceStore } from '@/features/workspace/store.ts';
import { useCliSocket } from '@/hooks/useCliSocket.ts';
import { useTerminalBridge } from '@/hooks/useTerminalBridge.ts';
export function App() {
  const store = useWorkspaceStore();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const activeCliId = selectActiveCliId(store.workspaceState);
  const socketRef = useRef<Socket | null>(null);

  const terminal = useTerminalBridge({
    activeCliId,
    socketRef,
    setError: store.setError
  });

  const { socketConnected, clis, sendCommand } = useCliSocket({
    activeCliId,
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
    },
    onSnapshot: (nextSnapshot) => {
      store.setSnapshot(nextSnapshot);
    },
    onTerminalChunk: (payload) => {
      terminal.handleTerminalChunk(payload);
    }
  });

  const controller = useWorkspaceController({
    clis,
    sendCommand,
    socketConnected,
    store,
    terminal
  });

  function handleMobileSidebarOpen(): void {
    setMobileSidebarOpen(true);
  }

  function handleDesktopSidebarToggle(): void {
    controller.setSidebarCollapsed(!store.workspaceState.sidebarCollapsed);
  }

  return (
    <AppShell
      sidebar={<SidebarFeature clis={clis} controller={controller} mobileOpen={mobileSidebarOpen} onMobileOpenChange={setMobileSidebarOpen} store={store} />}
      mobilePane={store.mobilePane}
      renderHeader={() => (
        <HeaderFeature
          clis={clis}
          mobilePane={store.mobilePane}
          onMobilePaneChange={store.setMobilePane}
          onSidebarOpen={handleMobileSidebarOpen}
          onSidebarToggle={handleDesktopSidebarToggle}
          mobileSidebarOpen={mobileSidebarOpen}
          sidebarCollapsed={store.workspaceState.sidebarCollapsed}
          store={store}
        />
      )}
      chat={<ChatFeature clis={clis} controller={controller} socketConnected={socketConnected} store={store} />}
      terminal={<TerminalFeature store={store} terminal={terminal} />}
      composer={<ComposerFeature clis={clis} controller={controller} socketConnected={socketConnected} store={store} />}
    />
  );
}
