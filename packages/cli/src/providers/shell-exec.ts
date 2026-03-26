import path from 'node:path';

export interface ShellExecConfig {
  args: string[];
  command: string;
}

export function createShellExecConfig(commandName: string, commandArgs: string[], env: NodeJS.ProcessEnv): ShellExecConfig {
  const shellPath = env.SHELL?.trim();
  if (!shellPath) {
    throw new Error(`SHELL is required to start ${commandName}`);
  }

  return createShellLaunchConfig(shellPath, commandName, commandArgs);
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
