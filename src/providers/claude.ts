import type { ProjectSessionSummary } from '../../shared/protocol.ts';

import { listProjectSessions } from '../project-history.ts';
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
    listProjectConversations(projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]> {
      return listProjectSessions(projectRoot, maxSessions);
    },
    replayActiveState() {
      return manager.replayActiveState();
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
