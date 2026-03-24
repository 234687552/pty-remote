import { useEffect, useState } from 'react';
import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import { BUILTIN_SLASH_COMMANDS } from '@lzdi/pty-remote-protocol/runtime-types.ts';
import type { ListSlashCommandsResultPayload } from '@lzdi/pty-remote-protocol/protocol.ts';

import { Composer } from '@/components/Composer.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import { selectComposerViewModel } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface ComposerFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  onComposerHeightChange?: (height: number) => void;
  socketConnected: boolean;
  store: WorkspaceStore;
}

export function ComposerFeature({ clis, controller, onComposerHeightChange, socketConnected, store }: ComposerFeatureProps) {
  const viewModel = selectComposerViewModel(store, clis, socketConnected);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);

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
      onComposerHeightChange={onComposerHeightChange}
      placeholder={viewModel.placeholder}
      prompt={store.prompt}
      slashCommands={slashCommands}
      socketBadge={viewModel.socketBadge}
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
    />
  );
}
