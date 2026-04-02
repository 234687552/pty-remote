import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import type { ComposerAttachment } from '@/features/workspace/types.ts';
import { TerminalQuickKeys } from '@/components/TerminalQuickKeys.tsx';

interface StatusBadge {
  className: string;
  label: string;
  value: string;
}

interface ComposerProps {
  attachments: ComposerAttachment[];
  busy: boolean;
  canAttach: boolean;
  canCompose: boolean;
  canSend: boolean;
  canSendTerminalInput: boolean;
  canStop: boolean;
  cliBadge: StatusBadge;
  conversationBadge: StatusBadge;
  footerErrorText: string;
  prompt: string;
  slashCommands: string[];
  socketBadge: StatusBadge;
  statusActions?: React.ReactNode;
  placeholder: string;
  onAddImages: (files: File[]) => void;
  onPromptChange: (value: string) => void;
  onRemoveAttachment: (localId: string) => void;
  onStop: () => void;
  onSubmit: (event: React.FormEvent) => void;
  onTerminalInput: (input: string) => void;
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
  attachments,
  busy,
  canAttach,
  canCompose,
  canSend,
  canSendTerminalInput,
  canStop,
  cliBadge,
  conversationBadge,
  footerErrorText,
  placeholder,
  prompt,
  slashCommands,
  socketBadge,
  statusActions,
  onAddImages,
  onPromptChange,
  onRemoveAttachment,
  onStop,
  onSubmit,
  onTerminalInput
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const isPromptComposingRef = useRef(false);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT_PX);
  const [promptScrollable, setPromptScrollable] = useState(false);
  const [selection, setSelection] = useState({ start: prompt.length, end: prompt.length });
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);

  const activeSlashToken = useMemo(() => {
    if (selection.start !== selection.end) {
      return null;
    }

    let tokenStart = selection.start;
    while (tokenStart > 0 && !/\s/u.test(prompt[tokenStart - 1] ?? '')) {
      tokenStart -= 1;
    }

    let tokenEnd = selection.start;
    while (tokenEnd < prompt.length && !/\s/u.test(prompt[tokenEnd] ?? '')) {
      tokenEnd += 1;
    }

    const token = prompt.slice(tokenStart, tokenEnd);
    if (!token.startsWith('/')) {
      return null;
    }

    return {
      start: tokenStart,
      end: tokenEnd,
      query: token.slice(1).toLowerCase()
    };
  }, [prompt, selection]);

  const slashSuggestions = useMemo(() => {
    if (!activeSlashToken) {
      return [];
    }

    const query = activeSlashToken.query;
    if (!query) {
      return slashCommands;
    }

    return [...slashCommands]
      .map((command) => {
        const lower = command.toLowerCase();
        let score = Number.POSITIVE_INFINITY;
        if (lower === query) {
          score = 0;
        } else if (lower.startsWith(query)) {
          score = 1;
        } else if (lower.includes(query)) {
          score = 2;
        }

        return { command, score };
      })
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => left.score - right.score || left.command.localeCompare(right.command))
      .map((entry) => entry.command);
  }, [activeSlashToken, slashCommands]);

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
  }, [prompt, attachments.length]);

  useEffect(() => {
    const selection = pendingSelectionRef.current;
    const textarea = promptRef.current;
    if (selection == null || !textarea) {
      return;
    }

    pendingSelectionRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(selection, selection);
    setSelection({ start: selection, end: selection });
  }, [prompt]);

  useEffect(() => {
    if (slashSuggestions.length === 0) {
      setSelectedSlashIndex(0);
      return;
    }

    setSelectedSlashIndex((current) => Math.min(current, slashSuggestions.length - 1));
  }, [slashSuggestions]);

  function handleImageInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      onAddImages(files);
    }
    event.currentTarget.value = '';
  }

  function insertPromptText(text: string): void {
    if (!canCompose) {
      return;
    }

    const textarea = promptRef.current;
    const selectionStart = textarea?.selectionStart ?? prompt.length;
    const selectionEnd = textarea?.selectionEnd ?? prompt.length;
    const nextPrompt = `${prompt.slice(0, selectionStart)}${text}${prompt.slice(selectionEnd)}`;
    pendingSelectionRef.current = selectionStart + text.length;
    onPromptChange(nextPrompt);
  }

  function applySlashCommand(command: string): void {
    if (!command || !activeSlashToken) {
      return;
    }

    const before = prompt.slice(0, activeSlashToken.start);
    const after = prompt.slice(activeSlashToken.end);
    const replacement = after.startsWith(' ') || after.length === 0 ? `/${command} ` : `/${command}`;
    pendingSelectionRef.current = activeSlashToken.start + replacement.length;
    onPromptChange(`${before}${replacement}${after}`);
  }

  function isComposingKeyEvent(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    return event.nativeEvent.isComposing || isPromptComposingRef.current || event.nativeEvent.keyCode === 229;
  }

  function requestComposerSubmit(): void {
    promptRef.current?.form?.requestSubmit();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="shrink-0 bg-transparent px-2 py-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)] md:mt-4 md:px-0 md:py-0"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleImageInputChange}
      />

      <div className="hidden items-center justify-between gap-3 px-1 pb-1 text-[11px] font-medium md:flex">
        <div className="min-w-0 flex flex-wrap gap-1.5">
          {[conversationBadge, socketBadge, cliBadge].map((badge) => (
            <span
              key={badge.label}
              className={[
                'min-w-0 truncate rounded-full px-2.5 py-0.5 text-center',
                badge.className
              ].join(' ')}
            >
              {badge.label}: {badge.value}
            </span>
          ))}
        </div>
        <div className="shrink-0">
          <TerminalQuickKeys variant="desktop" disabled={!canSendTerminalInput} onInput={onTerminalInput} />
        </div>
      </div>

      <div className="relative rounded-[1.5rem] border border-zinc-200/80 bg-zinc-100/90 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] md:bg-white md:shadow-none">
        {statusActions ? <div className="border-b border-zinc-200/70 px-2 pt-0.5 pb-0.5 md:hidden">{statusActions}</div> : null}

        {canCompose && slashSuggestions.length > 0 ? (
          <div className="absolute inset-x-4 bottom-14 z-20 max-h-56 overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-1 shadow-[0_20px_50px_rgba(15,23,42,0.12)] backdrop-blur">
            {slashSuggestions.map((command, index) => {
              const selected = index === selectedSlashIndex;
              return (
                <button
                  key={command}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySlashCommand(command)}
                  className={[
                    'flex w-full items-center justify-between rounded-2xl px-4 py-2 text-left text-sm transition',
                    selected ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                  ].join(' ')}
                >
                  <span className="font-medium">/{command}</span>
                  <span className={selected ? 'text-white/65' : 'text-zinc-400'}>↵</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {attachments.map((attachment) => (
              <div
                key={attachment.localId}
                className={[
                  'relative overflow-hidden rounded-2xl border border-zinc-200 bg-white',
                  attachment.status === 'error' ? 'border-red-200 bg-red-50' : ''
                ].join(' ')}
              >
                <div className="flex h-20 w-20 items-center justify-center overflow-hidden bg-zinc-100">
                  {attachment.previewUrl ? (
                    <img src={attachment.previewUrl} alt={attachment.filename} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs text-zinc-400">IMG</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.localId)}
                  className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-black"
                  aria-label={`删除 ${attachment.filename}`}
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
                    <path d="M4 4l8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                <div className="w-20 px-2 py-1.5">
                  <div className="truncate text-[10px] font-medium text-zinc-700">{attachment.filename}</div>
                  <div
                    className={[
                      'mt-0.5 text-[10px]',
                      attachment.status === 'ready'
                        ? 'text-emerald-600'
                        : attachment.status === 'error'
                          ? 'text-red-600'
                          : 'text-zinc-500'
                    ].join(' ')}
                  >
                    {attachment.status === 'ready' ? '已就绪' : attachment.status === 'error' ? '上传失败' : '上传中'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(event) => {
            onPromptChange(event.target.value);
            setSelection({
              start: event.target.selectionStart,
              end: event.target.selectionEnd
            });
          }}
          onKeyDown={(event) => {
            const isComposing = isComposingKeyEvent(event);

            if (slashSuggestions.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedSlashIndex((current) => (current + 1) % slashSuggestions.length);
                return;
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedSlashIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
                return;
              }

              if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !(isComposing && event.key === 'Enter')) {
                event.preventDefault();
                applySlashCommand(slashSuggestions[selectedSlashIndex] ?? slashSuggestions[0] ?? '');
                return;
              }
            }

            if (event.key !== 'Enter' || event.shiftKey) {
              return;
            }

            if (isComposing) {
              event.preventDefault();
              return;
            }

            event.preventDefault();
            requestComposerSubmit();
          }}
          onBeforeInput={(event) => {
            const nativeEvent = event.nativeEvent as InputEvent;
            if (nativeEvent.inputType !== 'insertLineBreak') {
              return;
            }

            event.preventDefault();
            if (isPromptComposingRef.current) {
              return;
            }

            requestComposerSubmit();
          }}
          onCompositionStart={() => {
            isPromptComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isPromptComposingRef.current = false;
          }}
          onPaste={(event) => {
            const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (imageFiles.length === 0) {
              return;
            }

            event.preventDefault();
            onAddImages(imageFiles);
          }}
          onClick={(event) => {
            setSelection({
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd
            });
          }}
          onKeyUp={(event) => {
            setSelection({
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd
            });
          }}
          onSelect={(event) => {
            setSelection({
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd
            });
          }}
          rows={1}
          placeholder={placeholder}
          enterKeyHint="send"
          className={[
            'w-full rounded-[1.5rem] border border-transparent bg-transparent px-6 pt-4 pr-24 pb-10 text-[16px] leading-6 text-zinc-800 outline-none ring-0 placeholder:text-zinc-500 focus:border-transparent',
            'resize-none',
            promptScrollable ? 'overflow-y-auto' : 'overflow-y-hidden'
          ].join(' ')}
          style={{ height: `${composerHeight}px` }}
          disabled={!canCompose}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-1 flex items-center justify-between px-5">
          <div className="pointer-events-auto flex items-center gap-2.5 text-zinc-500">
            {COMPOSER_TOOL_BUTTONS.map((button) => (
              <button
                key={button.id}
                type="button"
                onClick={() => {
                  if (button.id === 'image') {
                    fileInputRef.current?.click();
                    return;
                  }

                  if (button.id === 'slash') {
                    insertPromptText('/');
                  }
                }}
                className="flex h-6 min-w-6 items-center justify-center text-zinc-500 transition hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={button.label}
                disabled={
                  button.id === 'image'
                    ? !canAttach
                    : button.id === 'slash'
                      ? !canCompose
                      : false
                }
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
