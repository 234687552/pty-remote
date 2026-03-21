import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

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
      activeProviderId={store.workspaceState.activeProviderId}
      activeConversationId={store.workspaceState.activeConversationId}
      clis={clis}
      collapsed={store.workspaceState.sidebarCollapsed}
      mobileOpen={mobileOpen}
      projectConversationsByKey={store.projectConversationsByKey}
      projects={store.workspaceState.projects}
      onAddProject={controller.addProject}
      onActivateConversation={(project, providerId, conversation) => {
        void controller.activateConversation(project, providerId, conversation);
      }}
      onCreateConversation={controller.createConversation}
      onDeleteConversation={(project, providerId, conversation) =>
        controller.deleteConversation(project, providerId, conversation)
      }
      onImportConversationFromSession={controller.importConversationFromSession}
      onListManagedPtyHandles={controller.listManagedPtyHandles}
      onPickProjectDirectory={controller.pickProjectDirectory}
      onListRecentProjectSessions={(providerId, maxSessions) => controller.listRecentProjectSessions(providerId, maxSessions)}
      onMobileOpenChange={onMobileOpenChange}
      onSelectCli={controller.selectCli}
      onSelectProject={controller.selectProject}
    />
  );
}
