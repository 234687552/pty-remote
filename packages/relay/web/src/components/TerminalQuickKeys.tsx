const TERMINAL_QUICK_KEYS = [
  { id: 'escape', input: '\u001b', label: 'ESC', mobileLabel: 'ESC', title: '发送 Escape' },
  { id: 'arrow-up', input: '\u001b[A', label: '↑', mobileLabel: '↑', title: '发送上方向键' },
  { id: 'arrow-down', input: '\u001b[B', label: '↓', mobileLabel: '↓', title: '发送下方向键' },
  { id: 'enter', input: '\r', label: 'Enter', mobileLabel: '↵', title: '发送回车' }
] as const;

interface TerminalQuickKeysProps {
  disabled?: boolean;
  variant?: 'desktop' | 'mobile-action';
  onInput: (input: string) => void;
}

export function TerminalQuickKeys({ disabled = false, variant = 'desktop', onInput }: TerminalQuickKeysProps) {
  const mobileActionStyle = variant === 'mobile-action';

  return (
    <div className={['flex items-center', mobileActionStyle ? 'gap-1' : 'gap-1.5'].join(' ')}>
      {TERMINAL_QUICK_KEYS.map((key) => (
        <button
          key={key.id}
          type="button"
          onClick={() => onInput(key.input)}
          disabled={disabled}
          className={[
            mobileActionStyle
              ? 'flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200/80 bg-white/94 text-[11px] font-semibold text-zinc-700 shadow-[0_8px_20px_rgba(15,23,42,0.10)] backdrop-blur-md transition'
              : 'inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded-xl border border-zinc-200 bg-white px-2.5 text-[11px] font-semibold text-zinc-700 transition',
            mobileActionStyle
              ? disabled
                ? 'cursor-not-allowed text-zinc-300 opacity-70 shadow-none'
                : 'hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950'
              : '',
            mobileActionStyle
              ? ''
              : disabled
                ? 'cursor-not-allowed opacity-45'
                : 'hover:border-zinc-300 hover:text-zinc-950'
          ].join(' ')}
          aria-label={key.title}
          title={key.title}
        >
          {mobileActionStyle ? key.mobileLabel : key.label}
        </button>
      ))}
    </div>
  );
}
