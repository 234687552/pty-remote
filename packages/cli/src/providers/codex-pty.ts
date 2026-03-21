import { spawn as spawnPty, type IPty } from 'node-pty';

export interface CodexPtySession {
  pty: IPty;
  recentOutput: string;
  startupUpdatePromptHandled: boolean;
}

export type CodexPtyLifecycle = 'not_ready' | 'idle' | 'running';

interface StartCodexPtySessionOptions {
  codexBin: string;
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  resumeSessionId?: string | null;
  rows: number;
  onData: (chunk: string) => void;
  onExit: () => void;
}

export function createCodexLaunchConfig(
  codexBin: string,
  cwd: string,
  resumeSessionId?: string | null
): {
  args: string[];
  command: string;
} {
  const args = ['--no-alt-screen', '-C', cwd];
  if (resumeSessionId) {
    args.push('resume', resumeSessionId);
  }

  return {
    command: codexBin,
    args
  };
}

export function startCodexPtySession(options: StartCodexPtySessionOptions): CodexPtySession {
  const launch = createCodexLaunchConfig(options.codexBin, options.cwd, options.resumeSessionId);
  const pty = spawnPty(launch.command, launch.args, {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    name: 'xterm-256color'
  });

  const session: CodexPtySession = {
    pty,
    recentOutput: '',
    startupUpdatePromptHandled: false
  };

  pty.onData((chunk) => {
    options.onData(chunk);
  });

  pty.onExit(() => {
    options.onExit();
  });

  return session;
}

export function stopCodexPtySession(session: CodexPtySession | null): void {
  if (!session) {
    return;
  }

  try {
    session.pty.kill();
  } catch {
    // ignore
  }
}

export function resizeCodexPtySession(session: CodexPtySession | null, cols: number, rows: number): void {
  if (!session) {
    return;
  }

  try {
    session.pty.resize(cols, rows);
  } catch {
    // ignore resize failures during session transitions
  }
}

export function appendRecentOutput(session: CodexPtySession, chunk: string, maxChars: number): string {
  session.recentOutput = `${session.recentOutput}${chunk}`.slice(-maxChars);
  return session.recentOutput;
}

function normalizeOutput(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '\n');
}

function tailOutput(text: string, maxChars = 8_000): string {
  return normalizeOutput(text).slice(-maxChars);
}

const RUNNING_LINE_PATTERN = /(^|\n)\s*[•◦]\s+[^\n]*esc to interrupt[^\n]*$/gimu;
const PROMPT_LINE_PATTERN = /(^|\n)\s*[›>]\s*(?:Use \/skills[^\n]*)?$/gimu;
const PROMPT_HINT_PATTERN = /Use \/skills to list available skills|\? for shortcuts|% left/gi;
const DIRECTORY_TRUST_PROMPT_PATTERN = /Do you trust the contents of this directory\?/i;
const UPDATE_AVAILABLE_PROMPT_PATTERN = /Update\s+available!?/i;
const UPDATE_SKIP_OPTION_PATTERN = /(^|\n)\s*2\.\s*Skip(?:\s|$)/im;
const STARTER_PROMPT_PATTERN =
  /Improve documentation in @filename|To get started, describe a task|Implement\s+\{feature\}|Implement\s+<feature>/i;

function findLastMatchIndex(pattern: RegExp, text: string): number {
  let lastIndex = -1;

  for (const match of text.matchAll(pattern)) {
    lastIndex = match.index ?? lastIndex;
  }

  return lastIndex;
}

export function getCodexPtyLifecycle(output: string): CodexPtyLifecycle {
  const tail = tailOutput(output);
  const lastRunningIndex = findLastMatchIndex(RUNNING_LINE_PATTERN, tail);
  const lastPromptIndex = findLastMatchIndex(PROMPT_LINE_PATTERN, tail);
  const lastHintIndex = findLastMatchIndex(PROMPT_HINT_PATTERN, tail);

  if (lastRunningIndex > Math.max(lastPromptIndex, lastHintIndex)) {
    return 'running';
  }

  if (lastPromptIndex >= 0 || lastHintIndex >= 0) {
    return 'idle';
  }

  return 'not_ready';
}

export function looksReadyForInput(output: string): boolean {
  return getCodexPtyLifecycle(output) === 'idle';
}

export function looksLikeDirectoryTrustPrompt(output: string): boolean {
  return DIRECTORY_TRUST_PROMPT_PATTERN.test(tailOutput(output));
}

export function looksLikeUpdatePrompt(output: string): boolean {
  const tail = tailOutput(output);
  return UPDATE_AVAILABLE_PROMPT_PATTERN.test(tail) && UPDATE_SKIP_OPTION_PATTERN.test(tail);
}

export function showsStarterPrompt(output: string): boolean {
  return STARTER_PROMPT_PATTERN.test(tailOutput(output));
}
