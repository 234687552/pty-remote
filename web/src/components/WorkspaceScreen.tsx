import type { ComponentProps } from 'react';

import { AppHeader } from '@/components/AppHeader.tsx';
import { ChatPane } from '@/components/ChatPane.tsx';
import { Composer } from '@/components/Composer.tsx';
import { MobilePaneTabs, type WorkspacePane } from '@/components/MobilePaneTabs.tsx';
import { TerminalPane } from '@/components/TerminalPane.tsx';

export type { WorkspacePane } from '@/components/MobilePaneTabs.tsx';

interface WorkspaceScreenProps {
  chatPaneProps: ComponentProps<typeof ChatPane>;
  composerProps: ComponentProps<typeof Composer>;
  headerSummary: string[];
  mobilePane: WorkspacePane;
  terminalPaneProps: ComponentProps<typeof TerminalPane>;
  onMobilePaneChange: (pane: WorkspacePane) => void;
}

export function WorkspaceScreen({
  chatPaneProps,
  composerProps,
  headerSummary,
  mobilePane,
  terminalPaneProps,
  onMobilePaneChange
}: WorkspaceScreenProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3 overflow-hidden px-0 pt-3 pb-0 md:gap-4 md:p-6 lg:min-w-0 lg:flex-1">
      <main className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0 md:gap-4 md:pr-1">
          <AppHeader summary={headerSummary} />
          <MobilePaneTabs activePane={mobilePane} onChange={onMobilePaneChange} />

          <section className="min-h-0 flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-4">
            <ChatPane {...chatPaneProps} />
            <TerminalPane {...terminalPaneProps} />
          </section>
        </div>

        <Composer {...composerProps} />
      </main>
    </div>
  );
}
