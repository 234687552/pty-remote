import type { CliDescriptor } from '@shared/runtime-types.ts';

import { AppHeader } from '@/components/AppHeader.tsx';
import { selectHeaderSummary } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface HeaderFeatureProps {
  clis: CliDescriptor[];
  store: WorkspaceStore;
}

export function HeaderFeature({ clis, store }: HeaderFeatureProps) {
  return <AppHeader summary={selectHeaderSummary(store, clis)} />;
}
