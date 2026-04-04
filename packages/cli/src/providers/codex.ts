import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import { CodexAppServerManager, type CodexAppServerRuntimeOptions } from './codex-app-server-runtime.ts';
import type { ProviderRuntime, ProviderRuntimeCallbacks, ProviderRuntimeSelection } from './provider-runtime.ts';
import { listProviderSlashCommands } from './slash-commands.ts';

export type CodexProviderRuntimeOptions = CodexAppServerRuntimeOptions;

export function createCodexProviderRuntime(
  options: CodexProviderRuntimeOptions,
  callbacks: ProviderRuntimeCallbacks
): ProviderRuntime {
  const manager = new CodexAppServerManager(options, callbacks);

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
    hydrateConversation(selection) {
      return manager.hydrateConversation(selection);
    },
    listSlashCommands() {
      return listProviderSlashCommands('codex');
    },
    listProjectConversations(projectRoot: string, maxSessions?: number): Promise<ProjectSessionSummary[]> {
      return manager.listProjectConversations(projectRoot, maxSessions);
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
