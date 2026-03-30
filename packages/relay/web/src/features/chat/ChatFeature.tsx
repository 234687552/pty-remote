import { ChatPane } from '@/components/ChatPane.tsx';
import type { WorkspaceDerivedState } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';

interface ChatFeatureProps {
  derivedState: WorkspaceDerivedState;
  onMobileJumpControlsChange?: (controls: MobileJumpControls | null) => void;
  paneVisible: boolean;
  scrollToBottomRequestKey: number;
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

export function ChatFeature({
  derivedState,
  onMobileJumpControlsChange,
  paneVisible,
  scrollToBottomRequestKey,
  store,
  terminal
}: ChatFeatureProps) {
  const { activeCliId, activeConversation, activeProviderId, connected, visibleMessages } = derivedState;
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
