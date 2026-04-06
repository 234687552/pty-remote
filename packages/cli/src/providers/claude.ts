import type { ProjectSessionSummary } from '@lzdi/pty-remote-protocol/protocol.ts';

import { listClaudeRecentSessions } from './claude-history.ts';
import { ClaudeWsManager } from './claude-ws-runtime.ts';
import { listProviderSlashCommands } from './slash-commands.ts';
import type { PtyManagerOptions } from '../cli/pty-manager.ts';

import type { ProviderRuntime, ProviderRuntimeCallbacks, ProviderRuntimeSelection } from './provider-runtime.ts';

export function createClaudeProviderRuntime(
  options: PtyManagerOptions,
  callbacks: ProviderRuntimeCallbacks
): ProviderRuntime {
  const manager = new ClaudeWsManager(
    {
      defaultCwd: options.defaultCwd,
      permissionMode: options.permissionMode,
      snapshotMessagesMax: options.snapshotMessagesMax,
      claudeReadyTimeoutMs: options.claudeReadyTimeoutMs,
      gcIntervalMs: options.gcIntervalMs,
      terminalCols: options.terminalCols,
      terminalRows: options.terminalRows,
      terminalFrameScrollback: options.terminalFrameScrollback,
      model: process.env.CLAUDE_MODEL?.trim() || null,
      verbose: process.env.CLAUDE_WS_VERBOSE === '1'
    },
    callbacks
  );

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
    dispatchMessage(content: string, clientMessageId: string) {
      return manager.dispatchMessage(content, clientMessageId);
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
