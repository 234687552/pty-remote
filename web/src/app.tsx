import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type {
  CliCommandName,
  CliCommandPayloadMap,
  CliCommandResult,
  CliStatusPayload,
  MessagesUpdatePayload,
  RawJsonlUpdatePayload,
  TerminalChunkPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@shared/protocol.ts';
import type {
  ChatMessage,
  ChatMessageBlock,
  CliDescriptor,
  MessageStatus,
  RuntimeSnapshot,
  ToolUseChatMessageBlock
} from '@shared/runtime-types.ts';

function createEmptySnapshot(): RuntimeSnapshot {
  return {
    busy: false,
    sessionId: null,
    terminalReplay: '',
    rawJsonl: '',
    messages: [],
    lastError: null
  };
}

function getSocketBaseUrl(): string {
  const envValue = import.meta.env.VITE_SOCKET_URL;
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  return window.location.origin;
}

function MessageMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-body space-y-3 leading-6 text-zinc-800">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} className="text-blue-700 underline underline-offset-2" target="_blank" rel="noreferrer" />,
          blockquote: ({ ...props }) => <blockquote {...props} className="border-l-2 border-zinc-300 pl-4 text-zinc-600" />,
          code: ({ children, className, ...props }) => {
            const isBlock = Boolean(className);
            if (isBlock) {
              return (
                <code
                  {...props}
                  className={`${className} block overflow-x-auto rounded-xl bg-zinc-950 px-4 py-3 text-xs leading-5 text-zinc-100`}
                >
                  {children}
                </code>
              );
            }

            return (
              <code {...props} className="rounded bg-zinc-200 px-1.5 py-0.5 text-[0.85em] text-zinc-900">
                {children}
              </code>
            );
          },
          h1: ({ ...props }) => <h1 {...props} className="text-lg font-semibold text-zinc-950" />,
          h2: ({ ...props }) => <h2 {...props} className="text-base font-semibold text-zinc-950" />,
          h3: ({ ...props }) => <h3 {...props} className="text-sm font-semibold text-zinc-950" />,
          li: ({ ...props }) => <li {...props} className="ml-5 list-item" />,
          ol: ({ ...props }) => <ol {...props} className="list-decimal space-y-1 pl-5" />,
          p: ({ ...props }) => <p {...props} className="whitespace-pre-wrap break-words" />,
          pre: ({ ...props }) => <pre {...props} className="overflow-x-auto rounded-xl bg-zinc-950" />,
          ul: ({ ...props }) => <ul {...props} className="list-disc space-y-1 pl-5" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function getToolInputPreview(input: string, maxChars = 180): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no input)';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

type ToolVariantTone = 'generic' | 'shell' | 'web' | 'mcp';

function getToolVariant(toolName: string | undefined): { badgeLabel: string; tone: ToolVariantTone } {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { badgeLabel: 'TL', tone: 'generic' };
  }

  if (lower.includes('bash') || lower.includes('shell') || lower.includes('terminal')) {
    return { badgeLabel: '>_', tone: 'shell' };
  }

  if (lower.startsWith('web')) {
    return { badgeLabel: 'WEB', tone: 'web' };
  }

  if (lower.startsWith('mcp__')) {
    return { badgeLabel: 'MCP', tone: 'mcp' };
  }

  return {
    badgeLabel: normalized.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'TL',
    tone: 'generic'
  };
}

function getCompactToolTitle(toolName: string | undefined): string {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return 'Tool';
  }

  if (lower.includes('bash') || lower.includes('shell') || lower.includes('terminal')) {
    return 'Shell';
  }

  if (lower.startsWith('web')) {
    return normalized.split(/[.:/]/).at(-1) || 'Web';
  }

  if (lower.startsWith('mcp__')) {
    return normalized.split('__').at(-1) || 'MCP';
  }

  return normalized.split(/[.:/]/).at(-1) || normalized;
}

function getToolToneClasses(tone: ToolVariantTone): {
  badge: string;
  surface: string;
  border: string;
  title: string;
  meta: string;
} {
  switch (tone) {
    case 'shell':
      return {
        badge: 'bg-slate-900 text-white',
        surface: 'bg-slate-50',
        border: 'border-slate-200',
        title: 'text-slate-950',
        meta: 'text-slate-600'
      };
    case 'web':
      return {
        badge: 'bg-sky-600 text-white',
        surface: 'bg-sky-50',
        border: 'border-sky-200',
        title: 'text-sky-950',
        meta: 'text-sky-700'
      };
    case 'mcp':
      return {
        badge: 'bg-emerald-600 text-white',
        surface: 'bg-emerald-50',
        border: 'border-emerald-200',
        title: 'text-emerald-950',
        meta: 'text-emerald-700'
      };
    case 'generic':
    default:
      return {
        badge: 'bg-zinc-200 text-zinc-700',
        surface: 'bg-white',
        border: 'border-zinc-200',
        title: 'text-zinc-900',
        meta: 'text-zinc-500'
      };
  }
}

function ToolStatusIcon({ status }: { status: MessageStatus }) {
  if (status === 'error') {
    return <span className="inline-block h-2 w-2 rounded-full bg-red-600" />;
  }
  if (status === 'complete') {
    return <span className="inline-block h-2 w-2 rounded-full bg-emerald-600" />;
  }
  return <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />;
}

function ToolDetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      {children}
    </section>
  );
}

function hasNonTextBlock(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type !== 'text');
}

function MessageShell({ message, children }: { message: ChatMessage; children: React.ReactNode }) {
  if (hasNonTextBlock(message)) {
    return <>{children}</>;
  }

  const shellClass = [
    'rounded-xl border px-3 py-2.5 text-sm break-words',
    message.role === 'user'
      ? 'border-zinc-200 bg-zinc-50'
      : message.status === 'error'
        ? 'border-red-200 bg-red-50'
        : 'border-blue-200 bg-blue-50'
  ].join(' ');

  return (
    <article className={shellClass}>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
        <span>{message.role}</span>
        <span>{message.status}</span>
      </div>
      {children}
    </article>
  );
}

interface ToolCallMeta {
  toolName?: string;
  useBlockId?: string;
  resultStatus?: MessageStatus;
}

function createToolCallIndex(messages: ChatMessage[]): Map<string, ToolCallMeta> {
  const index = new Map<string, ToolCallMeta>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.toolCallId) {
        index.set(block.toolCallId, {
          ...index.get(block.toolCallId),
          toolName: block.toolName,
          useBlockId: block.id
        });
      }

      if (block.type === 'tool_result' && block.toolCallId) {
        index.set(block.toolCallId, {
          ...index.get(block.toolCallId),
          resultStatus: block.isError ? 'error' : 'complete'
        });
      }
    }
  }

  return index;
}

function TextBlockContent({ block, isStreaming }: { block: Extract<ChatMessageBlock, { type: 'text' }>; isStreaming: boolean }) {
  const content = isStreaming ? `${block.text}\n\n...` : block.text;
  return <MessageMarkdown content={content} />;
}

function resolveToolUseStatus(
  block: ToolUseChatMessageBlock,
  toolCallIndex: Map<string, ToolCallMeta>,
  fallbackStatus: MessageStatus
): MessageStatus {
  if (!block.toolCallId) {
    return fallbackStatus;
  }

  return toolCallIndex.get(block.toolCallId)?.resultStatus ?? fallbackStatus;
}

function ToolUseBlockContent({
  block,
  status
}: {
  block: ToolUseChatMessageBlock;
  status: MessageStatus;
}) {
  const variant = getToolVariant(block.toolName);
  const compactTitle = getCompactToolTitle(block.toolName);
  const toneClasses = getToolToneClasses(variant.tone);
  const summaryPreview = getToolInputPreview(block.input, 112);

  return (
    <details className={`group overflow-hidden rounded-lg border ${toneClasses.border} ${toneClasses.surface} shadow-sm`}>
      <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[8px] font-semibold ${toneClasses.badge}`}
            >
              {variant.badgeLabel}
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5">
              <div className={`shrink-0 text-[11px] font-medium ${toneClasses.title}`}>{compactTitle}</div>
              <div className={`min-w-0 truncate font-mono text-[11px] ${toneClasses.meta}`}>{summaryPreview || '(no input)'}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-500">
            <ToolStatusIcon status={status} />
            <span className="text-[10px] transition-transform group-open:rotate-180">▾</span>
          </div>
        </div>
      </summary>
      <div className={`space-y-3 border-t px-3 py-3 ${toneClasses.border}`}>
        <ToolDetailSection label="Input">
          <pre className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-[11px] leading-5 whitespace-pre-wrap break-all text-zinc-700">
            {block.input || '(no input)'}
          </pre>
        </ToolDetailSection>
      </div>
    </details>
  );
}

function hasRenderableMessageContent(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type !== 'tool_result');
}

function MessageContent({ message, toolCallIndex }: { message: ChatMessage; toolCallIndex: Map<string, ToolCallMeta> }) {
  if (message.blocks.length === 0) {
    return <MessageMarkdown content={message.status === 'streaming' ? '...' : ''} />;
  }

  return (
    <div className="space-y-2">
      {message.blocks.map((block, index) => {
        if (block.type === 'text') {
          const isLastBlock = index === message.blocks.length - 1;
          return <TextBlockContent key={block.id} block={block} isStreaming={message.status === 'streaming' && isLastBlock} />;
        }

        if (block.type === 'tool_use') {
          return (
            <ToolUseBlockContent
              key={block.id}
              block={block}
              status={resolveToolUseStatus(block, toolCallIndex, message.status)}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

export function App() {
  const [socketConnected, setSocketConnected] = useState(false);
  const [cli, setCli] = useState<CliDescriptor | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(createEmptySnapshot());
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');

  const socketRef = useRef<Socket | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const appliedReplayLengthRef = useRef(0);
  const appliedSessionIdRef = useRef<string | null>(null);

  const connected = Boolean(socketConnected && cli?.connected);
  const canCompose = connected && !snapshot.busy;
  const toolCallIndex = useMemo(() => createToolCallIndex(snapshot.messages), [snapshot.messages]);
  const renderableMessages = useMemo(
    () => snapshot.messages.filter((message) => hasRenderableMessageContent(message)),
    [snapshot.messages]
  );

  useEffect(() => {
    if (!terminalHostRef.current || terminalInstanceRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cols: 120,
      rows: 32,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: 'Berkeley Mono, SFMono-Regular, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#f8fafc',
        selectionBackground: 'rgba(148, 163, 184, 0.35)'
      }
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminalInstanceRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(terminalHostRef.current);

    return () => {
      observer.disconnect();
      terminal.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const socket = io(`${getSocketBaseUrl()}/web`, {
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
      setError('');
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
    });

    socket.on('web:init', (payload: WebInitPayload) => {
      setCli(payload.cli);
      setSnapshot(payload.snapshot ?? createEmptySnapshot());
    });

    socket.on('cli:update', (payload: CliStatusPayload) => {
      setCli(payload.cli);
    });

    socket.on('messages:update', (payload: MessagesUpdatePayload) => {
      setSnapshot((current) => {
        const sessionChanged = current.sessionId !== payload.sessionId;
        return {
          ...current,
          busy: payload.busy,
          sessionId: payload.sessionId,
          rawJsonl: sessionChanged ? '' : current.rawJsonl,
          messages: payload.messages,
          lastError: payload.lastError,
          terminalReplay: sessionChanged ? '' : current.terminalReplay
        };
      });
    });

    socket.on('raw-jsonl:update', (payload: RawJsonlUpdatePayload) => {
      setSnapshot((current) => {
        const sessionChanged = current.sessionId !== payload.sessionId;
        const currentRawJsonl = sessionChanged ? '' : current.rawJsonl;
        let nextRawJsonl = currentRawJsonl;

        if (payload.reset) {
          nextRawJsonl = payload.chunk;
        } else if (currentRawJsonl.length === payload.baseLength) {
          nextRawJsonl = `${currentRawJsonl}${payload.chunk}`;
        } else {
          nextRawJsonl = `${currentRawJsonl.slice(0, Math.max(0, payload.baseLength))}${payload.chunk}`;
        }

        return {
          ...current,
          sessionId: payload.sessionId,
          rawJsonl: nextRawJsonl
        };
      });
    });

    socket.on('terminal:chunk', (payload: TerminalChunkPayload) => {
      const terminal = terminalInstanceRef.current;
      if (!terminal) {
        return;
      }
      if (!payload.sessionId || payload.sessionId !== appliedSessionIdRef.current) {
        return;
      }

      terminal.write(payload.data);
      appliedReplayLengthRef.current += payload.data.length;
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    const nextReplay = snapshot.terminalReplay || '';
    const sessionChanged = appliedSessionIdRef.current !== snapshot.sessionId;
    const replayRewound = nextReplay.length < appliedReplayLengthRef.current;

    if (sessionChanged || replayRewound) {
      terminal.reset();
      if (nextReplay) {
        terminal.write(nextReplay);
      }
      appliedSessionIdRef.current = snapshot.sessionId;
      appliedReplayLengthRef.current = nextReplay.length;
      fitAddonRef.current?.fit();
      return;
    }

    if (nextReplay.length > appliedReplayLengthRef.current) {
      terminal.write(nextReplay.slice(appliedReplayLengthRef.current));
      appliedReplayLengthRef.current = nextReplay.length;
    }
  }, [snapshot.sessionId, snapshot.terminalReplay]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [renderableMessages]);

  const headerText = useMemo(() => {
    if (!socketConnected) {
      return 'waiting for socket';
    }
    if (!cli?.connected) {
      return 'waiting for cli';
    }
    if (snapshot.busy) {
      return 'running';
    }
    return 'idle';
  }, [cli?.connected, snapshot.busy, socketConnected]);

  async function sendCommand<TName extends CliCommandName>(name: TName, payload: CliCommandPayloadMap[TName]) {
    const socket = socketRef.current;
    if (!socket?.connected) {
      throw new Error('Socket is not connected');
    }

    const result = await new Promise<CliCommandResult>((resolve) => {
      socket.emit('web:command', { name, payload } satisfies WebCommandEnvelope<TName>, (ack?: CliCommandResult) => {
        resolve(ack ?? { ok: false, error: 'No response from server' });
      });
    });

    if (!result.ok) {
      throw new Error(result.error || 'Request failed');
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const content = prompt.trim();
    if (!content) {
      setError('请输入消息');
      return;
    }

    try {
      setError('');
      await sendCommand('send-message', { content });
      setPrompt('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function handleReset() {
    try {
      setError('');
      await sendCommand('reset-session', {});
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : '重置失败');
    }
  }

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 p-4 md:p-6">
        <header className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold">hapi-tmux</h1>
              <p className="text-sm text-zinc-500">raw PTY → xterm，聊天面板来自 Claude jsonl</p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-medium">
              <span className="rounded-full bg-zinc-900 px-3 py-1 text-white">socket: {socketConnected ? 'online' : 'offline'}</span>
              <span className="rounded-full bg-zinc-200 px-3 py-1 text-zinc-800">cli: {cli?.connected ? 'online' : 'offline'}</span>
              <span className="rounded-full bg-zinc-200 px-3 py-1 text-zinc-800">status: {headerText}</span>
              <span className="rounded-full bg-zinc-200 px-3 py-1 text-zinc-800">session: {snapshot.sessionId ?? '-'}</span>
            </div>
          </div>
          <div className="mt-3 grid gap-2 text-sm text-zinc-600 md:grid-cols-2">
            <div>label: {cli?.label ?? '-'}</div>
            <div>cwd: {cli?.cwd ?? '-'}</div>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr,1.2fr]">
          <div className="flex min-h-[28rem] flex-col rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-lg font-semibold">Messages</h2>
            </div>
            <div ref={messagesRef} className="flex-1 space-y-2 overflow-auto px-4 py-4">
              {renderableMessages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                  等待 Claude jsonl 写入会话内容。
                </div>
              ) : (
                renderableMessages.map((message) => (
                  <MessageShell key={message.id} message={message}>
                    <MessageContent message={message} toolCallIndex={toolCallIndex} />
                  </MessageShell>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-[28rem] flex-col rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-lg font-semibold">Terminal</h2>
            </div>
            <div className="terminal-shell flex-1 overflow-hidden rounded-b-3xl bg-slate-950 p-3">
              <div ref={terminalHostRef} className="h-full w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950" />
            </div>
          </div>
        </section>

        <form onSubmit={handleSubmit} className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Composer</h2>
            <button
              type="button"
              onClick={() => {
                void handleReset();
              }}
              className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!connected}
            >
              新会话
            </button>
          </div>

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            placeholder={!connected ? '等待 CLI 连接...' : snapshot.busy ? 'Claude 正在运行...' : '输入消息，点击发送。'}
            className="min-h-32 w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500"
            disabled={!canCompose}
          />

          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-red-600">{error || snapshot.lastError || ''}</div>
            <button
              type="submit"
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canCompose}
            >
              {snapshot.busy ? '处理中...' : '发送'}
            </button>
          </div>
        </form>

        <section className="rounded-3xl border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 px-4 py-3">
            <h2 className="text-lg font-semibold">Raw JSONL</h2>
          </div>
          <div className="p-4">
            {snapshot.rawJsonl ? (
              <pre className="max-h-[22rem] min-h-[14rem] overflow-auto rounded-2xl border border-zinc-200 bg-zinc-950 p-4 text-xs leading-5 whitespace-pre-wrap break-all text-zinc-100">
                {snapshot.rawJsonl}
              </pre>
            ) : (
              <div className="flex min-h-[14rem] items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                等待 Claude jsonl 原始内容。
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
