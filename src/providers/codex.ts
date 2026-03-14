import type { ProjectSessionSummary } from '../../shared/protocol.ts';

import { listCodexProjectSessions } from './codex-history.ts';
import { CodexManager, type CodexManagerOptions } from './codex-manager.ts';
import type { ProviderRuntime, ProviderRuntimeCallbacks, ProviderRuntimeSelection } from './provider-runtime.ts';

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
      return listCodexProjectSessions(projectRoot, maxSessions, options);
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
