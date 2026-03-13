import type { CliDescriptor } from '@shared/runtime-types.ts';

import { AppHeader } from '@/components/AppHeader.tsx';
import { selectHeaderSummary, selectMobileHeaderTitle } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { WorkspacePane } from '@/features/workspace/types.ts';

interface HeaderFeatureProps {
  clis: CliDescriptor[];
  mobilePane: WorkspacePane;
  mobileTitleVisible: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  store: WorkspaceStore;
}

export function HeaderFeature({ clis, mobilePane, mobileTitleVisible, onMobilePaneChange, store }: HeaderFeatureProps) {
  return (
    <AppHeader
      mobilePane={mobilePane}
      mobileTitle={selectMobileHeaderTitle(store, clis)}
      mobileTitleVisible={mobileTitleVisible}
      onMobilePaneChange={onMobilePaneChange}
      summary={selectHeaderSummary(store, clis)}
    />
  );
}
