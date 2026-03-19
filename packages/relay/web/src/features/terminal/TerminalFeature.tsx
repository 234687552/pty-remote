import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

import { TerminalPane } from '@/components/TerminalPane.tsx';

interface TerminalFeatureProps {
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

export function TerminalFeature({ store, terminal }: TerminalFeatureProps) {
  return (
    <TerminalPane
      frameSnapshot={terminal.frameSnapshot}
      hostRef={terminal.terminalHostRef}
      viewportRef={terminal.terminalViewportRef}
      visible={store.mobilePane === 'terminal'}
      onJumpToEdge={terminal.jumpToEdge}
    />
  );
}
