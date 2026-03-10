import { randomUUID } from 'node:crypto';

import { spawn as spawnPty, type IPty } from 'node-pty';

export interface ClaudePtySession {
  pty: IPty;
  recentOutput: string;
  replayChunks: string[];
  replayBytes: number;
}

export type ClaudePtyLifecycle = 'not_ready' | 'idle' | 'running';

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
  return normalizeOutput(text).slice(-maxChars);
}

function normalizeOutput(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '\n');
}

const RUNNING_LINE_PATTERN = /(^|\n)\s*[*·✶✻]\s+[^\n]*?\b[\p{L}-]*ing(?:\.{3}|…)?\s*$/gimu;
const PROMPT_LINE_PATTERN = /(^|\n)\s*>\s*[^\n]*$/gm;
const PROMPT_HINT_PATTERN = /Try\s+"|--\s*INSERT\s*--|Thinking on|shift\+tab to cycle|\/ide\b/gi;

function findLastMatchIndex(pattern: RegExp, text: string): number {
  let lastIndex = -1;

  for (const match of text.matchAll(pattern)) {
    lastIndex = match.index ?? lastIndex;
  }

  return lastIndex;
}

export function getClaudePtyLifecycle(output: string): ClaudePtyLifecycle {
  const tail = tailOutput(output);
  const lastRunningIndex = findLastMatchIndex(RUNNING_LINE_PATTERN, tail);
  const lastPromptIndex = findLastMatchIndex(PROMPT_LINE_PATTERN, tail);
  const lastHintIndex = findLastMatchIndex(PROMPT_HINT_PATTERN, tail);

  if (lastRunningIndex > Math.max(lastPromptIndex, lastHintIndex)) {
    return 'running';
  }

  if (lastPromptIndex >= 0 && lastHintIndex >= 0 && Math.max(lastPromptIndex, lastHintIndex) > lastRunningIndex) {
    return 'idle';
  }

  return 'not_ready';
}

export function looksReadyForInput(output: string): boolean {
  return getClaudePtyLifecycle(output) === 'idle';
}

export function looksLikeBypassPrompt(output: string): boolean {
  const plainText = tailOutput(output).toLowerCase();
  return plainText.includes('bypass permissions') && plainText.includes('yes, i accept');
}
