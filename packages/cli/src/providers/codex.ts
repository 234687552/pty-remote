import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import { listCodexRecentSessions } from './codex-history.ts';
import { CodexManager, type CodexManagerOptions } from './codex-manager.ts';
import type { ProviderRuntime, ProviderRuntimeCallbacks, ProviderRuntimeSelection } from './provider-runtime.ts';
import { listProviderSlashCommands } from './slash-commands.ts';

export type CodexProviderRuntimeOptions = CodexManagerOptions;

export function createCodexProviderRuntime(
  options: CodexProviderRuntimeOptions,
  callbacks: ProviderRuntimeCallbacks
): ProviderRuntime {
  const manager = new CodexManager(options, callbacks);

  return {
    providerId: 'codex',
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
    getSnapshot() {
      return manager.getSnapshot();
    },
    listSlashCommands() {
      return listProviderSlashCommands('codex');
    },
    listProjectConversations(_projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]> {
      return listCodexRecentSessions(maxSessions, options);
    },
    listManagedPtyHandles() {
      return Promise.resolve(manager.listManagedPtyHandles());
    },
    primeActiveTerminalFrame() {
      return manager.primeActiveTerminalFrame();
    },
    refreshActiveState() {
      return manager.refreshActiveState();
    },
    resetActiveConversation() {
      return manager.resetActiveThread();
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
