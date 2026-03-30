import { useEffect, useState } from 'react';
import { BUILTIN_SLASH_COMMANDS, PROVIDER_LABELS } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import type { ListSlashCommandsResultPayload } from '@lzdi/pty-remote-protocol/protocol.ts';

import { Composer } from '@/components/Composer.tsx';
import { MobileFileBrowserSheet } from '@/components/MobileFileBrowserSheet.tsx';
import { MobileFloatingControls } from '@/components/MobileFloatingControls.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import type { ComposerViewModel, WorkspaceDerivedState } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { MobileJumpControls, WorkspacePane } from '@/features/workspace/types.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';

interface ComposerFeatureProps {
  controller: WorkspaceController;
  derivedState: WorkspaceDerivedState;
  jumpControls: MobileJumpControls | null;
  mobilePane: WorkspacePane;
  mobileProjectTitle: string;
  mobileSidebarOpen: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarOpen: () => void;
  store: WorkspaceStore;
  terminal: TerminalBridge;
  viewModel: ComposerViewModel;
}

export function ComposerFeature({
  controller,
  derivedState,
  jumpControls,
  mobilePane,
  mobileProjectTitle,
  mobileSidebarOpen,
  onMobilePaneChange,
  onSidebarOpen,
  store,
  terminal,
  viewModel
}: ComposerFeatureProps) {
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [mobileFileBrowserOpen, setMobileFileBrowserOpen] = useState(false);
  const mobileAgentLabel =
    store.workspaceState.activeProviderId ? PROVIDER_LABELS[store.workspaceState.activeProviderId] : 'agent';
  const canSendTerminalInput = Boolean(viewModel.activeCliId && viewModel.activeProviderId && derivedState.connected);
  const canOpenFiles = Boolean(derivedState.activeProject?.cwd && derivedState.activeCliId && derivedState.connected);

  useEffect(() => {
    if (mobileSidebarOpen) {
      setMobileFileBrowserOpen(false);
    }
  }, [mobileSidebarOpen]);

  useEffect(() => {
    if (!canOpenFiles) {
      setMobileFileBrowserOpen(false);
    }
  }, [canOpenFiles]);

  useEffect(() => {
    const activeProviderId = viewModel.activeProviderId;
    const fallbackCommands = activeProviderId ? BUILTIN_SLASH_COMMANDS[activeProviderId] ?? [] : [];

    if (!viewModel.activeCliId || !activeProviderId || !derivedState.connected) {
      setSlashCommands(fallbackCommands);
      return;
    }

    let cancelled = false;
    setSlashCommands(fallbackCommands);

    void controller
      .sendCommand('list-slash-commands', {}, viewModel.activeCliId, activeProviderId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const payload = result.payload as ListSlashCommandsResultPayload | undefined;
        setSlashCommands(payload?.commands ?? fallbackCommands);
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommands(fallbackCommands);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [controller.sendCommand, derivedState.connected, viewModel.activeCliId, viewModel.activeProviderId]);

  return (
    <>
      <Composer
        attachments={store.pendingAttachments}
        busy={viewModel.busy}
        canAttach={viewModel.canAttach}
        canCompose={viewModel.canCompose}
        canSend={viewModel.canSend}
        canStop={viewModel.canStop}
        cliBadge={viewModel.cliBadge}
        conversationBadge={viewModel.conversationBadge}
        footerErrorText={viewModel.footerErrorText}
        placeholder={viewModel.placeholder}
        prompt={store.prompt}
        slashCommands={slashCommands}
        socketBadge={viewModel.socketBadge}
        canSendTerminalInput={canSendTerminalInput}
        statusActions={
          <MobileFloatingControls
            canOpenFiles={canOpenFiles}
            canSendTerminalInput={canSendTerminalInput}
            jumpControls={jumpControls}
            mobileAgentLabel={mobileAgentLabel}
            mobilePane={mobilePane}
            mobileProjectTitle={mobileProjectTitle}
            mobileSidebarOpen={mobileSidebarOpen}
            statusBadges={[viewModel.conversationBadge, viewModel.socketBadge, viewModel.cliBadge]}
            onFilesOpen={() => {
              setMobileFileBrowserOpen(true);
            }}
            onMobilePaneChange={onMobilePaneChange}
            onSidebarOpen={onSidebarOpen}
            onTerminalInput={terminal.sendInput}
          />
        }
        onAddImages={(files) => {
          void controller.addImageAttachments(files);
        }}
        onPromptChange={store.setPrompt}
        onRemoveAttachment={(localId) => {
          void controller.removePendingAttachment(localId);
        }}
        onStop={() => {
          void controller.stopMessage();
        }}
        onSubmit={controller.submitPrompt}
        onTerminalInput={terminal.sendInput}
      />

      <MobileFileBrowserSheet
        activeCliId={derivedState.activeCliId}
        activeProviderId={derivedState.activeProviderId}
        onClose={() => {
          setMobileFileBrowserOpen(false);
        }}
        open={mobileFileBrowserOpen}
        projectCwd={derivedState.activeProject?.cwd ?? null}
        projectLabel={derivedState.activeProject?.label ?? mobileProjectTitle}
        sendCommand={controller.sendCommand}
        setPrompt={store.setPrompt}
      />
    </>
  );
}
