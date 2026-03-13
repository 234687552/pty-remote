interface StatusBadge {
  className: string;
  label: string;
  value: string;
}

interface ComposerProps {
  busy: boolean;
  canSend: boolean;
  canStop: boolean;
  cliBadge: StatusBadge;
  conversationBadge: StatusBadge;
  footerErrorText: string;
  prompt: string;
  socketBadge: StatusBadge;
  placeholder: string;
  onPromptChange: (value: string) => void;
  onStop: () => void;
  onSubmit: (event: React.FormEvent) => void;
}

export function Composer({
  busy,
  canSend,
  canStop,
  cliBadge,
  conversationBadge,
  footerErrorText,
  placeholder,
  prompt,
  socketBadge,
  onPromptChange,
  onStop,
  onSubmit
}: ComposerProps) {
  return (
    <form onSubmit={onSubmit} className="shrink-0 px-1 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:-mx-6 md:-mb-6 md:px-3 md:py-2 md:pb-2">
      <div className="mb-1.5 grid grid-cols-3 gap-1.5 text-[11px] font-medium md:flex md:flex-wrap md:gap-2 md:text-xs">
        {[conversationBadge, socketBadge, cliBadge].map((badge) => (
          <span key={badge.label} className={['truncate rounded-full px-2.5 py-1 text-center md:px-3', badge.className].join(' ')}>
            {badge.label}: {badge.value}
          </span>
        ))}
      </div>

      <div className="relative">
        <input
          type="text"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={placeholder}
          className="h-14 w-full rounded-xl border border-zinc-300 bg-white px-5 pr-28 text-sm outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500"
          disabled={!canSend}
        />
        <button
          type={busy ? 'button' : 'submit'}
          onClick={busy ? onStop : undefined}
          className="absolute top-1/2 right-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy ? !canStop : !canSend}
          aria-label={busy ? '结束当前运行' : '发送消息'}
          title={busy ? '结束当前运行' : '发送消息'}
        >
          {busy ? (
            <span className="block h-3.5 w-3.5 rounded-[0.2rem] bg-current" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
              <path d="M10 14V6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M6.5 9.5 10 6l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>

      {footerErrorText ? <div className="mt-1.5 text-sm text-red-600 sm:text-right">{footerErrorText}</div> : null}
    </form>
  );
}
