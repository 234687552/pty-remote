import { spawn as spawnPty, type IPty } from 'node-pty';

import { createCodexShellExecConfig } from './codex-shell.ts';

export interface CodexAppServerTerminalSession {
  pty: IPty;
  sessionId: string;
  wsUrl: string;
}

interface StartCodexAppServerTerminalSessionOptions {
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
  sessionId: string;
  wsUrl: string;
  onData: (chunk: string) => void;
  onExit: () => void;
}

export function createCodexAppServerTerminalLaunchConfig(
  env: NodeJS.ProcessEnv,
  wsUrl: string,
  sessionId: string
): {
  args: string[];
  command: string;
} {
  return createCodexShellExecConfig(['--remote', wsUrl, '--no-alt-screen', 'resume', sessionId], env);
}

export function startCodexAppServerTerminalSession(
  options: StartCodexAppServerTerminalSessionOptions
): CodexAppServerTerminalSession {
  const launch = createCodexAppServerTerminalLaunchConfig(options.env, options.wsUrl, options.sessionId);
  const pty = spawnPty(launch.command, launch.args, {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    name: 'xterm-256color'
  });

  pty.onData((chunk) => {
    options.onData(chunk);
  });

  pty.onExit(() => {
    options.onExit();
  });

  return {
    pty,
    sessionId: options.sessionId,
    wsUrl: options.wsUrl
  };
}

export function stopCodexAppServerTerminalSession(session: CodexAppServerTerminalSession | null): void {
  if (!session) {
    return;
  }
  try {
    session.pty.kill();
  } catch {
    // ignore
  }
}

export function resizeCodexAppServerTerminalSession(
  session: CodexAppServerTerminalSession | null,
  cols: number,
  rows: number
): void {
  if (!session) {
    return;
  }
  try {
    session.pty.resize(cols, rows);
  } catch {
    // ignore
  }
}
