import { useRef } from 'react';

import type { TerminalChunkPayload } from '@shared/protocol.ts';

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
  const activeCliId = selectActiveCliId(store.workspaceState);
  const terminalEventHandlersRef = useRef<{
    onConnect: () => void;
    onDisconnect: () => void;
    onTerminalChunk: (payload: TerminalChunkPayload) => void;
  }>({
    onConnect: () => undefined,
    onDisconnect: () => undefined,
    onTerminalChunk: () => undefined
  });

  const { socketConnected, clis, socketRef, sendCommand } = useCliSocket({
    activeCliId,
    onConnect: () => terminalEventHandlersRef.current.onConnect(),
    onDisconnect: () => terminalEventHandlersRef.current.onDisconnect(),
    onMessagesUpsert: (payload) => {
      store.applyMessagesUpsert(payload);
    },
    onSnapshot: (nextSnapshot) => {
      store.setSnapshot(nextSnapshot);
    },
    onTerminalChunk: (payload) => {
      terminalEventHandlersRef.current.onTerminalChunk(payload);
    }
  });

  const terminal = useTerminalBridge({
    activeCliId,
    socketRef,
    setError: store.setError
  });

  terminalEventHandlersRef.current.onConnect = () => {
    terminal.handleSocketConnected();
    store.setError('');
  };
  terminalEventHandlersRef.current.onDisconnect = () => {
    terminal.handleSocketDisconnected();
  };
  terminalEventHandlersRef.current.onTerminalChunk = (payload) => {
    terminal.handleTerminalChunk(payload);
  };

  const controller = useWorkspaceController({
    clis,
    sendCommand,
    socketConnected,
    store,
    terminal
  });

  return (
    <AppShell
      sidebar={<SidebarFeature clis={clis} controller={controller} store={store} />}
      mobilePane={store.mobilePane}
      renderHeader={({ mobileTitleVisible }) => (
        <HeaderFeature
          clis={clis}
          mobilePane={store.mobilePane}
          mobileTitleVisible={mobileTitleVisible}
          onMobilePaneChange={store.setMobilePane}
          store={store}
        />
      )}
      chat={<ChatFeature clis={clis} controller={controller} socketConnected={socketConnected} store={store} />}
      terminal={<TerminalFeature store={store} terminal={terminal} />}
      composer={<ComposerFeature clis={clis} controller={controller} socketConnected={socketConnected} store={store} />}
    />
  );
}
