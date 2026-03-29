import { useMemo } from 'react';

import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { ChatPane } from '@/components/ChatPane.tsx';
import { selectWorkspaceDerivedState } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';

interface ChatFeatureProps {
  clis: CliDescriptor[];
  onMobileJumpControlsChange?: (controls: MobileJumpControls | null) => void;
  paneVisible: boolean;
  scrollToBottomRequestKey: number;
  socketConnected: boolean;
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

export function ChatFeature({
  clis,
  onMobileJumpControlsChange,
  paneVisible,
  scrollToBottomRequestKey,
  socketConnected,
  store,
  terminal
}: ChatFeatureProps) {
  const { activeCliId, activeConversation, activeProviderId, connected, visibleMessages } = useMemo(
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
  const canSendApprovalInput = Boolean(activeCliId && activeProviderId && connected);

  return (
    <ChatPane
      activeProviderId={activeProviderId}
      canSendApprovalInput={canSendApprovalInput}
      conversationScrollKey={activeConversation ? `${activeProviderId ?? 'unknown'}:${activeConversation.conversationKey}` : null}
      connected={connected}
      frameSnapshot={terminal.frameSnapshot}
      messages={visibleMessages}
      onMobileJumpControlsChange={onMobileJumpControlsChange}
      onApprovalInput={terminal.sendInput}
      paneVisible={paneVisible}
      scrollToBottomRequestKey={scrollToBottomRequestKey}
      visible={store.mobilePane === 'chat'}
    />
  );
}
