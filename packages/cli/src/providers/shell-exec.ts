import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface ShellExecConfig {
  args: string[];
  command: string;
}

let preferredShellPathCache: string | null | undefined;

export function createShellExecConfig(commandName: string, commandArgs: string[], env: NodeJS.ProcessEnv): ShellExecConfig {
  const shellPath = resolvePreferredShellPath(env);
  if (!shellPath) {
    throw new Error(`SHELL is required to start ${commandName}`);
  }

  return createShellLaunchConfig(shellPath, commandName, commandArgs);
}

export function normalizeProcessShellEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const shellPath = resolvePreferredShellPath(env);
  if (shellPath) {
    env.SHELL = shellPath;
  }
  return shellPath;
}

export function resolvePreferredShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (preferredShellPathCache !== undefined) {
    return preferredShellPathCache;
  }

  const macDefaultShell = readMacDefaultShell();
  if (macDefaultShell) {
    preferredShellPathCache = macDefaultShell;
    return preferredShellPathCache;
  }

  preferredShellPathCache = env.SHELL?.trim() || null;
  return preferredShellPathCache;
}

function createShellLaunchConfig(shellPath: string, shellCommand: string, commandArgs: string[]): ShellExecConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  const commandText = [shellCommand, ...commandArgs.map(shellEscapeArg)].join(' ');

  if (shellName === 'sh' || shellName === 'dash') {
    return {
      command: shellPath,
      args: ['-lc', commandText]
    };
  }

  return {
    command: shellPath,
    args: ['-i', '-l', '-c', commandText]
  };
}

function shellEscapeArg(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readMacDefaultShell(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const username = os.userInfo().username;
    if (!username) {
      return null;
    }

    const output = execFileSync('dscl', ['.', '-read', `/Users/${username}`, 'UserShell'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const match = output.match(/UserShell:\s*(\S+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
