import type { CliDescriptor } from '@shared/runtime-types.ts';
import { PROVIDER_LABELS } from '@shared/runtime-types.ts';

import { AppHeader } from '@/components/AppHeader.tsx';
import { selectHeaderSummary, selectMobileProjectTitle } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { WorkspacePane } from '@/features/workspace/types.ts';

interface HeaderFeatureProps {
  clis: CliDescriptor[];
  mobilePane: WorkspacePane;
  mobileSidebarOpen: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarOpen: () => void;
  onSidebarToggle: () => void;
  sidebarCollapsed: boolean;
  store: WorkspaceStore;
}

export function HeaderFeature({
  clis,
  mobilePane,
  mobileSidebarOpen,
  onMobilePaneChange,
  onSidebarOpen,
  onSidebarToggle,
  sidebarCollapsed,
  store
}: HeaderFeatureProps) {
  const activeProviderLabel =
    store.workspaceState.activeProviderId ? PROVIDER_LABELS[store.workspaceState.activeProviderId] : 'agent';

  return (
    <AppHeader
      activeProviderId={store.workspaceState.activeProviderId}
      mobileAgentLabel={activeProviderLabel}
      mobilePane={mobilePane}
      mobileProjectTitle={selectMobileProjectTitle(store, clis)}
      mobileSidebarOpen={mobileSidebarOpen}
      onMobilePaneChange={onMobilePaneChange}
      onSidebarOpen={onSidebarOpen}
      onSidebarToggle={onSidebarToggle}
      onSidebarToggleTopChange={store.setSidebarToggleTop}
      onSidebarToggleTopCommit={store.commitSidebarToggleTop}
      sidebarCollapsed={sidebarCollapsed}
      sidebarToggleTop={store.sidebarToggleTop}
      summary={selectHeaderSummary(store, clis)}
    />
  );
}
