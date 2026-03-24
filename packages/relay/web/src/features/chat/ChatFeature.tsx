import { useMemo } from 'react';

import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { ChatPane } from '@/components/ChatPane.tsx';
import { selectWorkspaceDerivedState } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';

interface ChatFeatureProps {
  clis: CliDescriptor[];
  onMobileJumpControlsChange?: (controls: MobileJumpControls | null) => void;
  paneVisible: boolean;
  scrollToBottomRequestKey: number;
  socketConnected: boolean;
  store: WorkspaceStore;
}

export function ChatFeature({
  clis,
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
      messages={visibleMessages}
      onMobileJumpControlsChange={onMobileJumpControlsChange}
      paneVisible={paneVisible}
      scrollToBottomRequestKey={scrollToBottomRequestKey}
      visible={store.mobilePane === 'chat'}
    />
  );
}
