import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import { listClaudeRecentSessions } from './claude-history.ts';
import { listProviderSlashCommands } from './slash-commands.ts';
import { PtyManager, type PtyManagerOptions } from '../cli/pty-manager.ts';

import type { ProviderRuntime, ProviderRuntimeCallbacks, ProviderRuntimeSelection } from './provider-runtime.ts';

export function createClaudeProviderRuntime(
  options: PtyManagerOptions,
  callbacks: ProviderRuntimeCallbacks
): ProviderRuntime {
  const manager = new PtyManager(options, callbacks);

  return {
    providerId: 'claude',
    activateConversation(selection: ProviderRuntimeSelection) {
      return manager.activateConversation(selection);
    },
    cleanupConversation(target) {
      return manager.cleanupConversation(target);
    },
    cleanupProject(cwd: string) {
      return manager.cleanupProject(cwd);
    },
    dispatchMessage(content: string) {
      return manager.dispatchMessage(content);
    },
    getRegistrationPayload() {
      return manager.getRegistrationPayload();
    },
    listSlashCommands() {
      return listProviderSlashCommands('claude');
    },
    listProjectConversations(_projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]> {
      return listClaudeRecentSessions(maxSessions);
    },
    listManagedPtyHandles() {
      return Promise.resolve(manager.listManagedPtyHandles());
    },
    resetActiveConversation() {
      return manager.resetActiveThread();
    },
    sendTerminalInput(input: string) {
      return manager.sendTerminalInput(input);
    },
    shutdown() {
      return manager.shutdown();
    },
    stopActiveRun() {
      return manager.stopActiveRun();
    },
    updateTerminalSize(cols: number, rows: number) {
      manager.updateTerminalSize(cols, rows);
    }
  };
}
