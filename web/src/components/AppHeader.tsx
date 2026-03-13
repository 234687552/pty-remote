interface AppHeaderProps {
  summary: string[];
}

export function AppHeader({ summary }: AppHeaderProps) {
  const [cliSummary, projectSummary, cwdSummary, threadSummary, sessionSummary] = summary;

  return (
    <header className="mx-4 rounded-3xl border border-zinc-200 bg-white px-4 py-3 shadow-sm lg:mx-0">
      <div className="space-y-2 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <span className="text-base font-semibold text-zinc-900">pty-remote</span>
          <span className="max-w-[45%] truncate rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-600">
            {cliSummary}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2">
            <div className="text-[11px] font-medium text-zinc-500">当前项目</div>
            <div className="truncate text-sm font-medium text-zinc-900">{projectSummary}</div>
          </div>
          <div className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2">
            <div className="text-[11px] font-medium text-zinc-500">当前线程</div>
            <div className="truncate text-sm font-medium text-zinc-900">{threadSummary}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="min-w-0 truncate rounded-full bg-zinc-100 px-2.5 py-1">{sessionSummary}</span>
        </div>
        <div className="truncate text-[11px] text-zinc-500">{cwdSummary}</div>
      </div>

      <div className="hidden items-center gap-3 overflow-x-auto whitespace-nowrap text-sm text-zinc-600 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden lg:flex">
        <span className="text-base font-semibold text-zinc-900">pty-remote</span>
        {summary.map((item) => (
          <span key={item} className="flex items-center gap-3">
            <span className="text-zinc-300">/</span>
            <span>{item}</span>
          </span>
        ))}
      </div>
    </header>
  );
}
