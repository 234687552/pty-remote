import { useEffect, useState } from 'react';
import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import { BUILTIN_SLASH_COMMANDS, PROVIDER_LABELS } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import type { ListSlashCommandsResultPayload } from '@lzdi/pty-remote-protocol/protocol.ts';

import { Composer } from '@/components/Composer.tsx';
import { MobileFloatingControls } from '@/components/MobileFloatingControls.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import { selectComposerViewModel, selectMobileProjectTitle } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';
import type { MobileJumpControls, WorkspacePane } from '@/features/workspace/types.ts';
import type { TerminalBridge } from '@/hooks/useTerminalBridge.ts';

interface ComposerFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  jumpControls: MobileJumpControls | null;
  mobilePane: WorkspacePane;
  mobileSidebarOpen: boolean;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  onSidebarOpen: () => void;
  socketConnected: boolean;
  store: WorkspaceStore;
  terminal: TerminalBridge;
}

export function ComposerFeature({
  clis,
  controller,
  jumpControls,
  mobilePane,
  mobileSidebarOpen,
  onMobilePaneChange,
  onSidebarOpen,
  socketConnected,
  store,
  terminal
}: ComposerFeatureProps) {
  const viewModel = selectComposerViewModel(store, clis, socketConnected);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const mobileAgentLabel =
    store.workspaceState.activeProviderId ? PROVIDER_LABELS[store.workspaceState.activeProviderId] : 'agent';
  const canSendTerminalInput = Boolean(viewModel.activeCliId && viewModel.activeProviderId && socketConnected);

  useEffect(() => {
    const activeProviderId = viewModel.activeProviderId;
    const fallbackCommands = activeProviderId ? BUILTIN_SLASH_COMMANDS[activeProviderId] ?? [] : [];

    if (!viewModel.activeCliId || !activeProviderId || !socketConnected) {
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
  }, [controller.sendCommand, socketConnected, viewModel.activeCliId, viewModel.activeProviderId]);

  return (
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
          canSendTerminalInput={canSendTerminalInput}
          jumpControls={jumpControls}
          mobileAgentLabel={mobileAgentLabel}
          mobilePane={mobilePane}
          mobileProjectTitle={selectMobileProjectTitle(store, clis)}
          mobileSidebarOpen={mobileSidebarOpen}
          statusBadges={[viewModel.conversationBadge, viewModel.socketBadge, viewModel.cliBadge]}
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
  );
}
