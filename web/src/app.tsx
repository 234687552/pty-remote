import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';

import type {
  CliCommandName,
  CliCommandPayloadMap,
  CliCommandResult,
  CliStatusPayload,
  MessagesUpdatePayload,
  TerminalChunkPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@shared/protocol.ts';
import type { CliDescriptor, RuntimeSnapshot } from '@shared/runtime-types.ts';

function createEmptySnapshot(): RuntimeSnapshot {
  return {
    busy: false,
    sessionId: null,
    terminalReplay: '',
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
  const canSend = connected && !snapshot.busy;

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
          messages: payload.messages,
          lastError: payload.lastError,
          terminalReplay: sessionChanged ? '' : current.terminalReplay
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
  }, [snapshot.messages]);

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
            <div ref={messagesRef} className="flex-1 space-y-3 overflow-auto px-4 py-4">
              {snapshot.messages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                  等待 Claude jsonl 写入会话内容。
                </div>
              ) : (
                snapshot.messages.map((message) => (
                  <article
                    key={message.id}
                    className={[
                      'rounded-2xl border p-3 text-sm whitespace-pre-wrap break-words',
                      message.role === 'user'
                        ? 'border-zinc-200 bg-zinc-50'
                        : message.status === 'error'
                          ? 'border-red-200 bg-red-50'
                          : 'border-blue-200 bg-blue-50'
                    ].join(' ')}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-zinc-500">
                      <span>{message.role}</span>
                      <span>{message.status}</span>
                    </div>
                    <div>{message.content || (message.status === 'streaming' ? '...' : '')}</div>
                  </article>
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
            placeholder={connected ? '输入消息，点击发送。' : '等待 CLI 连接...'}
            className="min-h-32 w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500"
            disabled={!connected}
          />

          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-red-600">{error || snapshot.lastError || ''}</div>
            <button
              type="submit"
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canSend}
            >
              {snapshot.busy ? '处理中...' : '发送'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
