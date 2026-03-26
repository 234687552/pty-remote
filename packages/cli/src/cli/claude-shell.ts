import { createShellExecConfig, type ShellExecConfig } from '../providers/shell-exec.ts';

export type ClaudeShellExecConfig = ShellExecConfig;

export function createClaudeShellExecConfig(claudeArgs: string[], env: NodeJS.ProcessEnv): ClaudeShellExecConfig {
  return createShellExecConfig('claude', claudeArgs, env);
}
