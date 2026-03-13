import type { ReactNode } from 'react';

import { MobilePaneTabs } from '@/components/MobilePaneTabs.tsx';
import type { WorkspacePane } from '@/features/workspace/types.ts';

interface AppShellProps {
  chat: ReactNode;
  composer: ReactNode;
  header: ReactNode;
  mobilePane: WorkspacePane;
  onMobilePaneChange: (pane: WorkspacePane) => void;
  sidebar: ReactNode;
  terminal: ReactNode;
}

export function AppShell({ chat, composer, header, mobilePane, onMobilePaneChange, sidebar, terminal }: AppShellProps) {
  return (
    <div className="h-dvh overflow-hidden bg-white text-zinc-900 lg:flex lg:bg-zinc-100">
      {sidebar}

      <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3 overflow-hidden px-0 pt-3 pb-0 md:gap-4 md:p-6 lg:min-w-0 lg:flex-1">
        <main className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0 md:gap-4 md:pr-1">
            {header}
            <MobilePaneTabs activePane={mobilePane} onChange={onMobilePaneChange} />

            <section className="min-h-0 flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-4">
              {chat}
              {terminal}
            </section>
          </div>

          {composer}
        </main>
      </div>
    </div>
  );
}
