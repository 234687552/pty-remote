import { useEffect, useRef, useState } from 'react';

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

const COMPOSER_TOOL_BUTTONS = [
  {
    id: 'image',
    label: '插入图片',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
        <rect x="3.25" y="4.25" width="13.5" height="11.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="7.25" cy="8" r="1.25" fill="currentColor" />
        <path
          d="M5.5 13.5 8.5 10.5a1 1 0 0 1 1.42 0l1.58 1.58a1 1 0 0 0 1.41 0l1.59-1.58"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    id: 'slash',
    label: '斜杠命令',
    icon: <span className="text-[15px] leading-none font-semibold">/</span>
  },
  {
    id: 'tool-1',
    label: '功能一',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
        <path
          d="M10 3.5 11.65 7l3.85.55-2.8 2.72.66 3.73L10 12.2 6.64 14l.66-3.73L4.5 7.55 8.35 7 10 3.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    id: 'tool-2',
    label: '功能二',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
        <path d="M5 6h10M5 10h10M5 14h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="13.5" cy="14" r="1.5" fill="currentColor" />
      </svg>
    )
  }
] as const;

const COMPOSER_MIN_HEIGHT_PX = 86;
const COMPOSER_MAX_HEIGHT_PX = 134;

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
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT_PX);
  const [promptScrollable, setPromptScrollable] = useState(false);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }

    const syncPromptHeight = () => {
      textarea.style.height = `${COMPOSER_MIN_HEIGHT_PX}px`;
      const nextHeight = Math.min(Math.max(textarea.scrollHeight, COMPOSER_MIN_HEIGHT_PX), COMPOSER_MAX_HEIGHT_PX);
      textarea.style.height = `${nextHeight}px`;
      setComposerHeight(nextHeight);
      setPromptScrollable(textarea.scrollHeight > COMPOSER_MAX_HEIGHT_PX);
    };

    syncPromptHeight();

    const resizeObserver = new ResizeObserver(() => {
      syncPromptHeight();
    });
    if (textarea.parentElement) {
      resizeObserver.observe(textarea.parentElement);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [prompt]);

  return (
    <form
      onSubmit={onSubmit}
      className="shrink-0 bg-transparent px-2 py-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)] md:mt-4 md:px-0 md:py-0"
    >
      <div className="mb-1 grid grid-cols-3 gap-0.5 px-1 text-[9px] font-medium md:mb-px md:flex md:flex-wrap md:gap-1.5 md:px-0 md:text-[11px]">
        {[conversationBadge, socketBadge, cliBadge].map((badge) => (
          <span
            key={badge.label}
            className={['truncate rounded-full px-1.5 py-0.5 text-center opacity-80 md:px-2.5 md:opacity-100', badge.className].join(' ')}
          >
            {badge.label}: {badge.value}
          </span>
        ))}
      </div>

      <div className="relative rounded-[1.5rem] border border-zinc-200/80 bg-zinc-100/90 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] md:bg-white md:shadow-none">
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) {
              return;
            }

            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          rows={1}
          placeholder={placeholder}
          className={[
            'w-full rounded-[1.5rem] border border-transparent bg-transparent px-6 pt-4 pr-24 pb-10 text-[16px] leading-6 text-zinc-800 outline-none ring-0 placeholder:text-zinc-500 focus:border-transparent',
            'resize-none',
            promptScrollable ? 'overflow-y-auto' : 'overflow-y-hidden'
          ].join(' ')}
          style={{ height: `${composerHeight}px` }}
          disabled={!canSend}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-1 flex items-center justify-between px-5">
          <div className="pointer-events-auto flex items-center gap-2.5 text-zinc-500">
            {COMPOSER_TOOL_BUTTONS.map((button) => (
              <button
                key={button.id}
                type="button"
                className="flex h-6 min-w-6 items-center justify-center text-zinc-500 transition hover:text-zinc-800"
                aria-label={button.label}
              >
                {button.icon}
              </button>
            ))}
          </div>
        </div>
        <button
          type={busy ? 'button' : 'submit'}
          onClick={busy ? onStop : undefined}
          className="absolute right-4 bottom-0.5 flex h-16 w-16 scale-[0.62] items-center justify-center rounded-full bg-black text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy ? !canStop : !canSend}
          aria-label={busy ? '结束当前运行' : '发送消息'}
        >
          {busy ? (
            <span className="block h-4.5 w-4.5 rounded-[0.24rem] bg-current" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-6 w-6">
              <path d="M10 14.5V5.5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
              <path d="M5.8 9.8 10 5.5l4.2 4.3" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>

      {footerErrorText ? <div className="mt-1.5 text-sm text-red-600 sm:text-right">{footerErrorText}</div> : null}
    </form>
  );
}
