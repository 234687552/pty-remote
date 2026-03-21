import type { ReactNode } from 'react';

import type { WorkspacePane } from '@/features/workspace/types.ts';

interface AppShellProps {
  chat: ReactNode;
  composer: ReactNode;
  mobilePane: WorkspacePane;
  renderHeader: () => ReactNode;
  sidebar: ReactNode;
  terminal: ReactNode;
}

export function AppShell({ chat, composer, mobilePane, renderHeader, sidebar, terminal }: AppShellProps) {
  return (
    <div className="h-svh overflow-hidden bg-white text-zinc-900 lg:flex lg:h-dvh lg:bg-zinc-100">
      {sidebar}

      <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-2 overflow-hidden px-0 pt-0 pb-0 md:gap-4 md:p-6 lg:min-w-0 lg:flex-1">
        <main className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0 md:gap-4 md:pr-1">
            {renderHeader()}
            <section className="min-h-0 flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-4">
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
