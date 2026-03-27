import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { AppHeader } from '@/components/AppHeader.tsx';
import { selectHeaderSummary } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface HeaderFeatureProps {
  clis: CliDescriptor[];
  onSidebarToggle: () => void;
  sidebarCollapsed: boolean;
  store: WorkspaceStore;
}

export function HeaderFeature({
  clis,
  onSidebarToggle,
  sidebarCollapsed,
  store
}: HeaderFeatureProps) {
  return (
    <AppHeader
      activeProviderId={store.workspaceState.activeProviderId}
      onSidebarToggle={onSidebarToggle}
      onSidebarToggleTopChange={store.setSidebarToggleTop}
      onSidebarToggleTopCommit={store.commitSidebarToggleTop}
      sidebarCollapsed={sidebarCollapsed}
      sidebarToggleTop={store.sidebarToggleTop}
      summary={selectHeaderSummary(store, clis)}
    />
  );
}
