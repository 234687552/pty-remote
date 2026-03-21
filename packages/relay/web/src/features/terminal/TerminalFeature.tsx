import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

import { TerminalPane } from '@/components/TerminalPane.tsx';
import type { MobileJumpControls } from '@/features/workspace/types.ts';

interface TerminalFeatureProps {
  onMobileJumpControlsChange?: (controls: MobileJumpControls | null) => void;
  scrollToBottomRequestKey: number;
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

export function TerminalFeature({ onMobileJumpControlsChange, scrollToBottomRequestKey, store, terminal }: TerminalFeatureProps) {
  return (
    <TerminalPane
      frameSnapshot={terminal.frameSnapshot}
      hostRef={terminal.terminalHostRef}
      onMobileJumpControlsChange={onMobileJumpControlsChange}
      scrollToBottomRequestKey={scrollToBottomRequestKey}
      viewportRef={terminal.terminalViewportRef}
      visible={store.mobilePane === 'terminal'}
      onJumpToEdge={terminal.jumpToEdge}
    />
  );
}
