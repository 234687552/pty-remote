import { useMemo } from 'react';

import type { CliDescriptor } from '@shared/runtime-types.ts';

import { ChatPane } from '@/components/ChatPane.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import {
  selectActiveCli,
  selectActiveCliId,
  selectActiveProject,
  selectVisibleMessages
} from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface ChatFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  socketConnected: boolean;
  store: WorkspaceStore;
}

export function ChatFeature({ clis, controller, socketConnected, store }: ChatFeatureProps) {
  const connected = useMemo(() => {
    const activeProject = selectActiveProject(store.workspaceState);
    const activeCliId = selectActiveCliId(store.workspaceState, activeProject);
    const activeCli = selectActiveCli(clis, activeCliId);
    return Boolean(socketConnected && activeCli?.connected);
  }, [clis, socketConnected, store.workspaceState]);

  const visibleMessages = useMemo(() => selectVisibleMessages(store), [store.olderMessages, store.snapshot.messages]);

  return (
    <ChatPane
      connected={connected}
      hasOlderMessages={store.hasOlderMessages}
      messages={visibleMessages}
      olderMessagesLoading={store.olderMessagesLoading}
      visible={store.mobilePane === 'chat'}
      onLoadOlderMessages={controller.loadOlderMessages}
    />
  );
}
