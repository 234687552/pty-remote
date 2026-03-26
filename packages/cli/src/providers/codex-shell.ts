import { createShellExecConfig, type ShellExecConfig } from './shell-exec.ts';

export type CodexShellExecConfig = ShellExecConfig;

export function createCodexShellExecConfig(codexArgs: string[], env: NodeJS.ProcessEnv): CodexShellExecConfig {
  return createShellExecConfig('codex', codexArgs, env);
}
