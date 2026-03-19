import { useMemo } from 'react';

import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { ChatPane } from '@/components/ChatPane.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import { selectWorkspaceDerivedState } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface ChatFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  socketConnected: boolean;
  store: WorkspaceStore;
}

export function ChatFeature({ clis, controller, socketConnected, store }: ChatFeatureProps) {
  const { activeProviderId, connected, visibleMessages } = useMemo(
    () => selectWorkspaceDerivedState(store, clis, socketConnected),
    [clis, socketConnected, store.olderMessages, store.projectConversationsByKey, store.snapshot, store.workspaceState]
  );

  return (
    <ChatPane
      activeProviderId={activeProviderId}
      connected={connected}
      hasOlderMessages={store.hasOlderMessages}
      messages={visibleMessages}
      olderMessagesLoading={store.olderMessagesLoading}
      visible={store.mobilePane === 'chat'}
      onLoadOlderMessages={controller.loadOlderMessages}
    />
  );
}
