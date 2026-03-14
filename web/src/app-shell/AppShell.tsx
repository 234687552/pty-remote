import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, TouchEvent, UIEvent } from 'react';

import type { WorkspacePane } from '@/features/workspace/types.ts';

interface HeaderRenderState {
  mobileTitleVisible: boolean;
}

interface AppShellProps {
  chat: ReactNode;
  composer: ReactNode;
  mobilePane: WorkspacePane;
  renderHeader: (state: HeaderRenderState) => ReactNode;
  sidebar: ReactNode;
  terminal: ReactNode;
}

export const MobileHeaderVisibilityContext = createContext<(visible: boolean) => void>(() => undefined);

export function AppShell({ chat, composer, mobilePane, renderHeader, sidebar, terminal }: AppShellProps) {
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const previousScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const [mobileTitleVisible, setMobileTitleVisible] = useState(false);
  const handleMobileHeaderVisibilityChange = useCallback((visible: boolean) => {
    setMobileTitleVisible(visible);
  }, []);

  useEffect(() => {
    setMobileTitleVisible(false);
    previousScrollTopRef.current = scrollViewportRef.current?.scrollTop ?? 0;
  }, [mobilePane]);

  function handleViewportScroll(event: UIEvent<HTMLDivElement>): void {
    const nextTop = event.currentTarget.scrollTop;
    const previousTop = previousScrollTopRef.current;
    const delta = nextTop - previousTop;
    previousScrollTopRef.current = nextTop;

    if (Math.abs(delta) < 6) {
      return;
    }

    setMobileTitleVisible(delta < 0);
  }

  function handleViewportTouchStart(event: TouchEvent<HTMLDivElement>): void {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handleViewportTouchMove(event: TouchEvent<HTMLDivElement>): void {
    const touchStartY = touchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (touchStartY == null || currentY == null) {
      return;
    }

    if (event.currentTarget.scrollTop > 4) {
      return;
    }

    const deltaY = currentY - touchStartY;
    if (deltaY > 14) {
      setMobileTitleVisible(true);
    } else if (deltaY < -8) {
      setMobileTitleVisible(false);
    }
  }

  function handleViewportTouchEnd(): void {
    touchStartYRef.current = null;
  }

  return (
    <MobileHeaderVisibilityContext.Provider value={handleMobileHeaderVisibilityChange}>
      <div className="h-svh overflow-hidden bg-white text-zinc-900 lg:flex lg:h-dvh lg:bg-zinc-100">
        {sidebar}

        <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-2 overflow-hidden px-0 pt-0 pb-0 md:gap-4 md:p-6 lg:min-w-0 lg:flex-1">
          <main className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden">
            <div
              ref={scrollViewportRef}
              onScroll={handleViewportScroll}
              onTouchStart={handleViewportTouchStart}
              onTouchMove={handleViewportTouchMove}
              onTouchEnd={handleViewportTouchEnd}
              onTouchCancel={handleViewportTouchEnd}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0 md:gap-4 md:pr-1"
            >
              {renderHeader({ mobileTitleVisible })}
              <section className="min-h-0 flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-2 lg:gap-4">
                {chat}
                {terminal}
              </section>
            </div>

            {composer}
          </main>
        </div>
      </div>
    </MobileHeaderVisibilityContext.Provider>
  );
}
