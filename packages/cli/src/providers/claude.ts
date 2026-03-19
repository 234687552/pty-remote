import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import { listClaudeRecentSessions } from './claude-history.ts';
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
    getOlderMessages(beforeMessageId?: string, maxMessages?: number) {
      return manager.getOlderMessages(beforeMessageId, maxMessages);
    },
    getRegistrationPayload() {
      return manager.getRegistrationPayload();
    },
    getSnapshot() {
      return manager.getSnapshot();
    },
    listProjectConversations(_projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]> {
      return listClaudeRecentSessions(maxSessions);
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
