import { useMemo } from 'react';

import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { ChatPane } from '@/components/ChatPane.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import { selectWorkspaceDerivedState } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';

interface ChatFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  onMobileJumpControlsChange?: (controls: MobileJumpControls | null) => void;
  paneVisible: boolean;
  scrollToBottomRequestKey: number;
  socketConnected: boolean;
  store: WorkspaceStore;
}

export function ChatFeature({
  clis,
  controller,
  onMobileJumpControlsChange,
  paneVisible,
  scrollToBottomRequestKey,
  socketConnected,
  store
}: ChatFeatureProps) {
  const { activeConversation, activeProviderId, connected, visibleMessages } = useMemo(
    () => selectWorkspaceDerivedState(store, clis, socketConnected),
    [
      clis,
      socketConnected,
      store.olderMessages,
      store.pendingAttachments,
      store.projectConversationsByKey,
      store.sentAttachmentBindingsByConversationId,
      store.snapshot,
      store.workspaceState
    ]
  );

  return (
    <ChatPane
      activeProviderId={activeProviderId}
      conversationScrollKey={activeConversation ? `${activeProviderId ?? 'unknown'}:${activeConversation.conversationKey}` : null}
      connected={connected}
      hasOlderMessages={store.hasOlderMessages}
      messages={visibleMessages}
      onMobileJumpControlsChange={onMobileJumpControlsChange}
      olderMessagesLoading={store.olderMessagesLoading}
      paneVisible={paneVisible}
      scrollToBottomRequestKey={scrollToBottomRequestKey}
      visible={store.mobilePane === 'chat'}
      onLoadOlderMessages={controller.loadOlderMessages}
    />
  );
}
