import type { CliDescriptor } from '@shared/runtime-types.ts';

import { Sidebar } from '@/components/Sidebar.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface SidebarFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  store: WorkspaceStore;
}

export function SidebarFeature({ clis, controller, mobileOpen, onMobileOpenChange, store }: SidebarFeatureProps) {
  return (
    <Sidebar
      activeCliId={store.workspaceState.activeCliId}
      activeProjectId={store.workspaceState.activeProjectId}
      activeThreadId={store.workspaceState.activeThreadId}
      clis={clis}
      collapsed={store.workspaceState.sidebarCollapsed}
      mobileOpen={mobileOpen}
      projectThreadsById={store.projectThreadsById}
      projects={store.workspaceState.projects}
      projectsRefreshing={store.projectsRefreshing}
      onActivateThread={(project, thread) => {
        void controller.activateThread(project, thread);
      }}
      onAddProject={() => {
        void controller.addProject();
      }}
      onMobileOpenChange={onMobileOpenChange}
      onCreateThread={controller.createThread}
      onRefreshAllProjects={() => {
        void controller.refreshAllProjectThreads();
      }}
      onSelectCli={controller.selectCli}
      onSelectProject={controller.selectProject}
    />
  );
}
