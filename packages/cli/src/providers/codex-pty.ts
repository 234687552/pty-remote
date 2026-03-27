import { spawn as spawnPty, type IPty } from 'node-pty';
import { createCodexShellExecConfig } from './codex-shell.ts';

export interface CodexPtySession {
  pty: IPty;
  recentOutput: string;
  startupDirectoryTrustPromptHandled: boolean;
  startupModelChoicePromptHandled: boolean;
  startupUpdatePromptHandled: boolean;
}

export type CodexPtyLifecycle = 'not_ready' | 'idle' | 'running';

interface StartCodexPtySessionOptions {
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  resumeSessionId?: string | null;
  rows: number;
  onData: (chunk: string) => void;
  onExit: () => void;
}

export function createCodexLaunchConfig(
  env: NodeJS.ProcessEnv,
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
  return createCodexShellExecConfig(args, env);
}

export function startCodexPtySession(options: StartCodexPtySessionOptions): CodexPtySession {
  const launch = createCodexLaunchConfig(options.env, options.cwd, options.resumeSessionId);
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
    startupDirectoryTrustPromptHandled: false,
    startupModelChoicePromptHandled: false,
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

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, '');
}

function normalizeOutput(text: string): string {
  return stripAnsi(text).replace(/\r/g, '\n');
}

function compactKeywordText(text: string): string {
  return normalizeOutput(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function includesAllKeywords(text: string, keywords: string[]): boolean {
  return keywords.every((keyword) => text.includes(keyword));
}

function tailOutput(text: string, maxChars = 8_000): string {
  return normalizeOutput(text).slice(-maxChars);
}

const RUNNING_LINE_PATTERN = /(^|\n)\s*[•◦]\s+[^\n]*esc to interrupt[^\n]*$/gimu;
const PROMPT_LINE_PATTERN = /(^|\n)\s*[›>]\s*[^\n]*$/gimu;
const DIRECTORY_TRUST_PROMPT_PATTERN = /Do you trust the contents of this directory\?/i;
const UPDATE_AVAILABLE_PROMPT_PATTERN = /Update\s+available!?/i;
const UPDATE_SKIP_OPTION_PATTERN = /(^|\n)\s*2\.\s*Skip(?:\s|$)/im;
const UPDATE_SKIP_UNTIL_NEXT_VERSION_PATTERN = /(^|\n)\s*3\.\s*Skip until next version(?:\s|$)/im;
const UPDATE_CONTINUE_PATTERN = /Press enter to continue/i;
const MODEL_CHOICE_HEADER_PATTERN = /Choose how you'd like Codex to proceed\./i;
const MODEL_TRY_NEW_OPTION_PATTERN = /(^|\n)\s*1\.\s*Try new model(?:\s|$)/im;
const MODEL_USE_EXISTING_OPTION_PATTERN = /(^|\n)\s*2\.\s*Use existing model(?:\s|$)/im;
const MODEL_CONFIRM_FOOTER_PATTERN = /Use\s+↑\/↓\s+to move,\s+press enter to confirm/i;
const DIRECTORY_TRUST_KEYWORDS = ['trust', 'directory', 'yes', 'continue'];
const MODEL_CHOICE_KEYWORDS = ['choose', 'codex', 'proceed', 'try', 'new', 'model', 'use', 'existing'];
const UPDATE_PROMPT_KEYWORDS = ['update', 'available', 'skip', 'continue'];
const STARTER_PROMPT_PATTERN =
  /Use \/skills to list available skills|Improve documentation in @filename|To get started, describe a task|Implement\s+\{feature\}|Implement\s+<feature>/i;

export function getCodexPtyLifecycle(output: string): CodexPtyLifecycle {
  const tail = tailOutput(output);
  const hasRunningLine = RUNNING_LINE_PATTERN.test(tail);
  const hasPromptLine = PROMPT_LINE_PATTERN.test(tail);

  if (hasRunningLine) {
    return 'running';
  }

  if (hasPromptLine) {
    return 'idle';
  }

  return 'not_ready';
}

export function looksReadyForInput(output: string): boolean {
  return getCodexPtyLifecycle(output) === 'idle';
}

export function looksLikeDirectoryTrustPrompt(output: string): boolean {
  const tail = tailOutput(output);
  return (
    DIRECTORY_TRUST_PROMPT_PATTERN.test(tail) ||
    includesAllKeywords(compactKeywordText(tail), DIRECTORY_TRUST_KEYWORDS)
  );
}

export function looksLikeModelChoicePrompt(output: string): boolean {
  const tail = tailOutput(output);
  const hasHeader = MODEL_CHOICE_HEADER_PATTERN.test(tail);
  const hasChoices =
    MODEL_TRY_NEW_OPTION_PATTERN.test(tail) && MODEL_USE_EXISTING_OPTION_PATTERN.test(tail);
  const hasFooter = MODEL_CONFIRM_FOOTER_PATTERN.test(tail);
  const hasKeywordShape = includesAllKeywords(compactKeywordText(tail), MODEL_CHOICE_KEYWORDS);
  return (hasHeader && hasChoices) || (hasChoices && hasFooter) || hasKeywordShape;
}

export function looksLikeUpdatePrompt(output: string): boolean {
  const tail = tailOutput(output);
  const hasHeader = UPDATE_AVAILABLE_PROMPT_PATTERN.test(tail);
  const hasSkipChoice =
    UPDATE_SKIP_OPTION_PATTERN.test(tail) || UPDATE_SKIP_UNTIL_NEXT_VERSION_PATTERN.test(tail);
  const hasFooter = UPDATE_CONTINUE_PATTERN.test(tail);
  const hasKeywordShape = includesAllKeywords(compactKeywordText(tail), UPDATE_PROMPT_KEYWORDS);
  return (hasHeader && (hasSkipChoice || hasFooter)) || hasKeywordShape;
}

export function showsStarterPrompt(output: string): boolean {
  return STARTER_PROMPT_PATTERN.test(tailOutput(output));
}
