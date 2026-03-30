import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { AppHeader } from '@/components/AppHeader.tsx';

interface HeaderFeatureProps {
  activeProviderId: ProviderId | null;
  desktopWorkspaceBrowserEnabled: boolean;
  desktopWorkspaceBrowserOpen: boolean;
  onDesktopWorkspaceBrowserToggle: () => void;
  onSidebarToggle: () => void;
  sidebarCollapsed: boolean;
  summary: string[];
}

export function HeaderFeature({
  activeProviderId,
  desktopWorkspaceBrowserEnabled,
  desktopWorkspaceBrowserOpen,
  onDesktopWorkspaceBrowserToggle,
  onSidebarToggle,
  sidebarCollapsed,
  summary
}: HeaderFeatureProps) {
  return (
    <AppHeader
      activeProviderId={activeProviderId}
      desktopWorkspaceBrowserEnabled={desktopWorkspaceBrowserEnabled}
      desktopWorkspaceBrowserOpen={desktopWorkspaceBrowserOpen}
      onDesktopWorkspaceBrowserToggle={onDesktopWorkspaceBrowserToggle}
      onSidebarToggle={onSidebarToggle}
      sidebarCollapsed={sidebarCollapsed}
      summary={summary}
    />
  );
}
