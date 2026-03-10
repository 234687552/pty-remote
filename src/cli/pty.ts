import { randomUUID } from 'node:crypto';

import { spawn as spawnPty, type IPty } from 'node-pty';

export interface ClaudePtySession {
  pty: IPty;
  recentOutput: string;
  replayChunks: string[];
  replayBytes: number;
}

interface StartClaudePtySessionOptions {
  claudeBin: string;
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  permissionMode: string;
  rows: number;
  onData: (chunk: string) => void;
  onExit: () => void;
}

export function createClaudeLaunchConfig(claudeBin: string, permissionMode: string): {
  command: string;
  args: string[];
  sessionId: string;
} {
  const sessionId = randomUUID();
  return {
    command: claudeBin,
    args: ['--permission-mode', permissionMode, '--session-id', sessionId],
    sessionId
  };
}

export function startClaudePtySession(options: StartClaudePtySessionOptions): {
  session: ClaudePtySession;
  sessionId: string;
} {
  const launch = createClaudeLaunchConfig(options.claudeBin, options.permissionMode);
  const pty = spawnPty(launch.command, launch.args, {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    name: 'xterm-256color'
  });

  const session: ClaudePtySession = {
    pty,
    recentOutput: '',
    replayChunks: [],
    replayBytes: 0
  };

  pty.onData((chunk) => {
    options.onData(chunk);
  });

  pty.onExit(() => {
    options.onExit();
  });

  return {
    session,
    sessionId: launch.sessionId
  };
}

export function stopClaudePtySession(session: ClaudePtySession | null): void {
  if (!session) {
    return;
  }

  try {
    session.pty.kill();
  } catch {
    // ignore
  }
}

export function appendReplayChunk(session: ClaudePtySession, chunk: string, maxReplayBytes: number): string {
  session.replayChunks.push(chunk);
  session.replayBytes += Buffer.byteLength(chunk);

  while (session.replayBytes > maxReplayBytes && session.replayChunks.length > 1) {
    const removed = session.replayChunks.shift();
    if (removed) {
      session.replayBytes -= Buffer.byteLength(removed);
    }
  }

  return session.replayChunks.join('');
}

export function appendRecentOutput(session: ClaudePtySession, chunk: string, maxChars: number): string {
  session.recentOutput = `${session.recentOutput}${chunk}`.slice(-maxChars);
  return session.recentOutput;
}

function tailOutput(text: string, maxChars = 8_000): string {
  return text.slice(-maxChars);
}

export function looksReadyForInput(output: string): boolean {
  const tail = tailOutput(output);
  return tail.includes('Claude is waiting for your input') || /(^|\n)\s*>\s*$/.test(tail);
}

export function looksLikeBypassPrompt(output: string): boolean {
  const plainText = tailOutput(output).toLowerCase();
  return plainText.includes('bypass permissions') && plainText.includes('yes, i accept');
}
