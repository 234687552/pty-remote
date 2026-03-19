import type { CliDescriptor } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { Composer } from '@/components/Composer.tsx';
import type { WorkspaceController } from '@/features/workspace/controller.ts';
import { selectComposerViewModel } from '@/features/workspace/selectors.ts';
import type { WorkspaceStore } from '@/features/workspace/store.ts';

interface ComposerFeatureProps {
  clis: CliDescriptor[];
  controller: WorkspaceController;
  socketConnected: boolean;
  store: WorkspaceStore;
}

export function ComposerFeature({ clis, controller, socketConnected, store }: ComposerFeatureProps) {
  const viewModel = selectComposerViewModel(store, clis, socketConnected);

  return (
    <Composer
      busy={viewModel.busy}
      canSend={viewModel.canSend}
      canStop={viewModel.canStop}
      cliBadge={viewModel.cliBadge}
      conversationBadge={viewModel.conversationBadge}
      footerErrorText={viewModel.footerErrorText}
      placeholder={viewModel.placeholder}
      prompt={store.prompt}
      socketBadge={viewModel.socketBadge}
      onPromptChange={store.setPrompt}
      onStop={() => {
        void controller.stopMessage();
      }}
      onSubmit={controller.submitPrompt}
    />
  );
}
