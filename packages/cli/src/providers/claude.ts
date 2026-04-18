import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import { listClaudeRecentSessions } from './claude-history.ts';
import { ClaudeWsManager, type ClaudeWsRuntimeOptions } from './claude-ws-runtime.ts';
import { listProviderSlashCommands } from './slash-commands.ts';

import type { ProviderRuntime, ProviderRuntimeCallbacks, ProviderRuntimeSelection } from './provider-runtime.ts';

export type ClaudeProviderRuntimeOptions = ClaudeWsRuntimeOptions;

export function createClaudeProviderRuntime(
  options: ClaudeProviderRuntimeOptions,
  callbacks: ProviderRuntimeCallbacks
): ProviderRuntime {
  const manager = new ClaudeWsManager(options, callbacks);

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
    dispatchMessage(content: string, clientMessageId: string, selection: ProviderRuntimeSelection) {
      return manager.dispatchMessage(content, clientMessageId, selection);
    },
    getRegistrationPayload() {
      return manager.getRegistrationPayload();
    },
    hydrateConversation(selection) {
      return manager.hydrateConversation(selection);
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
    resolveRuntimeRequest(payload) {
      return manager.resolveRuntimeRequest(payload);
    },
    resetActiveConversation() {
      return manager.resetActiveThread();
    },
    setTerminalVisibility(payload) {
      return manager.setTerminalVisibility(payload);
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
