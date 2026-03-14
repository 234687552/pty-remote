import type { CliDescriptor } from '@shared/runtime-types.ts';

import { AppHeader } from '@/components/AppHeader.tsx';
import { selectHeaderSummary, selectMobileProjectTitle } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { WorkspacePane } from '@/features/workspace/types.ts';

interface HeaderFeatureProps {
  clis: CliDescriptor[];
  mobilePane: WorkspacePane;
  mobileTitleVisible: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarToggle: () => void;
  sidebarCollapsed: boolean;
  store: WorkspaceStore;
}

export function HeaderFeature({
  clis,
  mobilePane,
  mobileTitleVisible,
  onMobilePaneChange,
  onSidebarToggle,
  sidebarCollapsed,
  store
}: HeaderFeatureProps) {
  return (
    <AppHeader
      mobileAgentLabel="Claude"
      mobilePane={mobilePane}
      mobileProjectTitle={selectMobileProjectTitle(store, clis)}
      mobileTitleVisible={mobileTitleVisible}
      onMobilePaneChange={onMobilePaneChange}
      onSidebarToggle={onSidebarToggle}
      onSidebarToggleTopChange={store.setSidebarToggleTop}
      onSidebarToggleTopCommit={store.commitSidebarToggleTop}
      sidebarCollapsed={sidebarCollapsed}
      sidebarToggleTop={store.sidebarToggleTop}
      summary={selectHeaderSummary(store, clis)}
    />
  );
}
