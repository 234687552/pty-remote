import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ManagedPtyHandleSummary,
  MessageDeltaPayload,
  MessagesUpsertPayload,
  ProjectSessionSummary,
  RuntimeMetaPayload,
  RuntimeRequestPayload,
  RuntimeRequestResolvedPayload,
  SelectConversationResultPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { TerminalFramePatchPayload } from '@lzdi/pty-remote-protocol/protocol.ts';
import type { ChatMessage, ChatMessageBlock, MessageStatus, RuntimeSnapshot, RuntimeStatus } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { CodexAppServerClient } from './codex-app-server-client.ts';
import {
  resizeCodexAppServerTerminalSession,
  startCodexAppServerTerminalSession,
  stopCodexAppServerTerminalSession,
  type CodexAppServerTerminalSession
} from './codex-app-server-terminal.ts';
import type {
  CodexAppServerThread,
  CodexAppServerThreadItem,
  CodexAppServerNotification,
  CodexAppServerServerRequest,
  CodexAppServerThreadListResponse,
  CodexAppServerThreadReadResponse,
  CodexAppServerThreadStartResponse,
  CodexAppServerTurn,
  CodexAppServerTurnStartResponse
} from './codex-app-server-protocol.ts';
import { HeadlessTerminalFrameState } from '../terminal/frame-state.ts';

export interface CodexAppServerRuntimeOptions {
  defaultCwd: string;
  snapshotMessagesMax: number;
  appServerReadyTimeoutMs: number;
  appServerPollIdleMs: number;
  appServerPollRunningMs: number;
  appServerPort?: number;
  terminalCols: number;
  terminalRows: number;
  terminalFrameScrollback: number;
}

interface CodexAppServerCallbacks {
  emitMessageDelta(payload: Omit<MessageDeltaPayload, 'cliId'>): void;
  emitMessagesUpsert(payload: Omit<MessagesUpsertPayload, 'cliId'>): void;
  emitRuntimeMeta(payload: Omit<RuntimeMetaPayload, 'cliId'>): void;
  emitRuntimeRequest(payload: Omit<RuntimeRequestPayload, 'cliId'>): void;
  emitRuntimeRequestResolved(payload: Omit<RuntimeRequestResolvedPayload, 'cliId'>): void;
  emitTerminalFramePatch(payload: {
    conversationKey: string | null;
    patch: TerminalFramePatchPayload['patch'];
  }): void;
  emitTerminalSessionEvicted(payload: {
    conversationKey: string | null;
    reason: string;
    sessionId: string;
  }): void;
}

interface CodexAppServerSelection {
  cwd: string;
  label: string;
  sessionId: string | null;
  conversationKey: string;
}

interface RuntimeCleanupTarget {
  cwd: string;
  conversationKey: string;
  sessionId: string | null;
}

interface AgentRuntimeState extends RuntimeSnapshot {
  allMessages: ChatMessage[];
}

interface CodexAppServerHandle {
  threadKey: string;
  cwd: string;
  label: string;
  sessionId: string | null;
  runtime: AgentRuntimeState;
  activeTurnId: string | null;
  initialized: boolean;
  lastActivityAt: number;
}

interface PendingRuntimeRequest {
  requestId: string | number;
  threadId: string;
  method: string;
  params: unknown;
}

interface ActiveTerminalSession {
  conversationKey: string;
  frameState: HeadlessTerminalFrameState;
  session: CodexAppServerTerminalSession;
  sessionId: string;
  token: number;
}

interface MaterializedThreadState {
  activeTurnId: string | null;
  allMessages: ChatMessage[];
  hasOlderMessages: boolean;
  lastError: string | null;
  messages: ChatMessage[];
  status: RuntimeStatus;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isThreadNotFoundError(error: unknown): boolean {
  return errorMessage(error, '').toLowerCase().includes('thread not found');
}

function isThreadNotMaterializedYetError(error: unknown): boolean {
  const message = errorMessage(error, '').toLowerCase();
  return message.includes('includeTurns is unavailable before first user message'.toLowerCase()) ||
    message.includes('thread') && message.includes('is not materialized yet');
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageEqual(left: ChatMessage | undefined, right: ChatMessage | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id &&
    left.role === right.role &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.sequence === right.sequence &&
    JSON.stringify(left.meta ?? null) === JSON.stringify(right.meta ?? null) &&
    JSON.stringify(left.blocks) === JSON.stringify(right.blocks)
  );
}

function messagesEqual(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => messageEqual(message, right[index]));
}

function formatCreatedAt(baseCreatedAtSeconds: number, sequence: number): string {
  return new Date(baseCreatedAtSeconds * 1_000 + sequence * 1_000).toISOString();
}

function createTextBlock(id: string, text: string): ChatMessageBlock[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  return [
    {
      id: `${id}:text:0`,
      type: 'text',
      text: normalized
    }
  ];
}

function createRawTextBlock(id: string, text: string): ChatMessageBlock[] {
  if (!text) {
    return [];
  }
  return [
    {
      id: `${id}:text:0`,
      type: 'text',
      text
    }
  ];
}

function createToolMessage(params: {
  id: string;
  toolName: string;
  input: string;
  result?: string | null;
  isError?: boolean;
  role?: 'assistant';
  createdAt: string;
  sequence: number;
  turnId: string | null;
  phase?: string | null;
  streaming?: boolean;
}): ChatMessage {
  const blocks: ChatMessageBlock[] = [
    {
      id: `${params.id}:use`,
      type: 'tool_use',
      toolCallId: params.id,
      toolName: params.toolName,
      input: params.input
    }
  ];
  if (params.result && params.result.trim()) {
    blocks.push({
      id: `${params.id}:result`,
      type: 'tool_result',
      toolCallId: params.id,
      content: params.result,
      isError: params.isError ?? false
    });
  }

  return {
    id: params.id,
    role: params.role ?? 'assistant',
    blocks,
    meta: {
      phase: params.phase ?? null,
      turnId: params.turnId
    },
    status: params.isError ? 'error' : params.streaming ? 'streaming' : 'complete',
    createdAt: params.createdAt,
    sequence: params.sequence
  };
}

function sortMessagesChronologically(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .slice()
    .sort(
      (left, right) =>
        (left.sequence ?? 0) - (right.sequence ?? 0) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    );
}

function mergeMessages(baseMessages: ChatMessage[], upserts: ChatMessage[]): ChatMessage[] {
  if (upserts.length === 0) {
    return baseMessages;
  }

  const nextMessages = baseMessages.slice();
  for (const upsert of upserts) {
    const existingIndex = nextMessages.findIndex((message) => message.id === upsert.id);
    if (existingIndex >= 0) {
      nextMessages[existingIndex] = upsert;
      continue;
    }
    nextMessages.push(upsert);
  }
  return sortMessagesChronologically(nextMessages);
}

function messageContentWeight(message: ChatMessage): number {
  return message.blocks.reduce((total, block) => {
    if (block.type === 'text') {
      return total + block.text.length;
    }
    if (block.type === 'tool_use') {
      return total + block.toolName.length + block.input.length;
    }
    return total + block.content.length;
  }, 0);
}

function messageStatusRank(status: MessageStatus): number {
  switch (status) {
    case 'error':
      return 3;
    case 'complete':
      return 2;
    case 'streaming':
    default:
      return 1;
  }
}

function shouldPreferPreviousRunningMessage(previous: ChatMessage, next: ChatMessage): boolean {
  const previousWeight = messageContentWeight(previous);
  const nextWeight = messageContentWeight(next);
  if (previousWeight !== nextWeight) {
    return previousWeight > nextWeight;
  }

  const previousStatusRank = messageStatusRank(previous.status);
  const nextStatusRank = messageStatusRank(next.status);
  if (previousStatusRank !== nextStatusRank) {
    return previousStatusRank > nextStatusRank;
  }

  if (previous.blocks.length !== next.blocks.length) {
    return previous.blocks.length > next.blocks.length;
  }

  return false;
}

function reconcileRunningTurnMessages(
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
  activeTurnId: string | null
): ChatMessage[] {
  if (!activeTurnId) {
    return nextMessages;
  }

  const reconciledMessages = new Map(nextMessages.map((message) => [message.id, message]));

  for (const previousMessage of previousMessages) {
    if (previousMessage.role !== 'assistant' || previousMessage.meta?.turnId !== activeTurnId) {
      continue;
    }

    const nextMessage = reconciledMessages.get(previousMessage.id);
    if (!nextMessage) {
      reconciledMessages.set(previousMessage.id, previousMessage);
      continue;
    }

    if (shouldPreferPreviousRunningMessage(previousMessage, nextMessage)) {
      reconciledMessages.set(previousMessage.id, previousMessage);
    }
  }

  return sortMessagesChronologically([...reconciledMessages.values()]);
}

function nextSyntheticSequence(messages: ChatMessage[]): number {
  return messages.reduce((maxSequence, message) => Math.max(maxSequence, message.sequence ?? 0), -1) + 1;
}

function upsertStreamingTextMessage(
  messages: ChatMessage[],
  params: {
    delta: string;
    id: string;
    phase?: string | null;
    turnId: string;
  }
): ChatMessage[] {
  if (!params.delta) {
    return messages;
  }

  const existingIndex = messages.findIndex((message) => message.id === params.id);
  if (existingIndex < 0) {
    return messages.concat({
      id: params.id,
      role: 'assistant',
      blocks: createRawTextBlock(params.id, params.delta),
      meta: {
        phase: params.phase ?? null,
        turnId: params.turnId
      },
      status: 'streaming',
      createdAt: new Date().toISOString(),
      sequence: nextSyntheticSequence(messages)
    });
  }

  const existing = messages[existingIndex];
  const nextBlocks = existing.blocks.slice();
  const textBlockIndex = nextBlocks.findIndex((block) => block.type === 'text');
  if (textBlockIndex < 0) {
    nextBlocks.push({
      id: `${params.id}:text:0`,
      type: 'text',
      text: params.delta
    });
  } else {
    const textBlock = nextBlocks[textBlockIndex];
    if (textBlock.type === 'text') {
      nextBlocks[textBlockIndex] = {
        ...textBlock,
        text: `${textBlock.text}${params.delta}`
      };
    }
  }

  const nextMessages = messages.slice();
  nextMessages[existingIndex] = {
    ...existing,
    blocks: nextBlocks,
    meta: {
      phase: existing.meta?.phase ?? params.phase ?? null,
      turnId: existing.meta?.turnId ?? params.turnId
    },
    status: existing.status === 'error' ? 'error' : 'streaming'
  };
  return nextMessages;
}

function upsertStreamingToolResultMessage(
  messages: ChatMessage[],
  params: {
    delta: string;
    id: string;
    toolName: string;
    turnId: string;
  }
): ChatMessage[] {
  if (!params.delta) {
    return messages;
  }

  const existingIndex = messages.findIndex((message) => message.id === params.id);
  if (existingIndex < 0) {
    return messages.concat(
      createToolMessage({
        id: params.id,
        toolName: params.toolName,
        input: '',
        result: params.delta,
        createdAt: new Date().toISOString(),
        sequence: nextSyntheticSequence(messages),
        turnId: params.turnId,
        streaming: true
      })
    );
  }

  const existing = messages[existingIndex];
  const nextBlocks = existing.blocks.slice();
  const resultBlockIndex = nextBlocks.findIndex((block) => block.type === 'tool_result');
  if (resultBlockIndex < 0) {
    nextBlocks.push({
      id: `${params.id}:result`,
      type: 'tool_result',
      toolCallId: params.id,
      content: params.delta,
      isError: false
    });
  } else {
    const resultBlock = nextBlocks[resultBlockIndex];
    if (resultBlock.type === 'tool_result') {
      nextBlocks[resultBlockIndex] = {
        ...resultBlock,
        content: `${resultBlock.content}${params.delta}`
      };
    }
  }

  const nextMessages = messages.slice();
  nextMessages[existingIndex] = {
    ...existing,
    blocks: nextBlocks,
    meta: {
      ...existing.meta,
      turnId: existing.meta?.turnId ?? params.turnId
    },
    status: existing.status === 'error' ? 'error' : 'streaming'
  };
  return nextMessages;
}

function notificationThreadId(notification: CodexAppServerNotification): string | null {
  const params = notification.params as Record<string, unknown> | undefined;
  return typeof params?.threadId === 'string' ? params.threadId : null;
}

function applyNotificationDelta(messages: ChatMessage[], notification: CodexAppServerNotification): ChatMessage[] {
  const params = notification.params as Record<string, unknown> | undefined;
  const itemId = typeof params?.itemId === 'string' ? params.itemId : null;
  const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
  const delta = typeof params?.delta === 'string' ? params.delta : '';
  if (!itemId || !turnId || !delta) {
    return messages;
  }

  switch (notification.method) {
    case 'item/agentMessage/delta':
      return upsertStreamingTextMessage(messages, {
        delta,
        id: itemId,
        phase: null,
        turnId
      });
    case 'item/plan/delta':
      return upsertStreamingTextMessage(messages, {
        delta,
        id: itemId,
        phase: 'plan',
        turnId
      });
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return upsertStreamingTextMessage(messages, {
        delta,
        id: itemId,
        phase: 'reasoning',
        turnId
      });
    case 'item/commandExecution/outputDelta':
      return upsertStreamingToolResultMessage(messages, {
        delta,
        id: itemId,
        toolName: 'command',
        turnId
      });
    case 'item/fileChange/outputDelta':
      return upsertStreamingTextMessage(messages, {
        delta,
        id: itemId,
        phase: 'file_change',
        turnId
      });
    default:
      return messages;
  }
}

function createMessageDeltaPayload(
  handle: Pick<CodexAppServerHandle, 'sessionId' | 'threadKey'>,
  notification: CodexAppServerNotification
): Omit<MessageDeltaPayload, 'cliId'> | null {
  const params = notification.params as Record<string, unknown> | undefined;
  const itemId = typeof params?.itemId === 'string' ? params.itemId : null;
  const delta = typeof params?.delta === 'string' ? params.delta : '';
  if (!itemId || !delta) {
    return null;
  }

  switch (notification.method) {
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
    case 'item/fileChange/outputDelta':
      return {
        providerId: 'codex',
        conversationKey: handle.threadKey,
        sessionId: handle.sessionId,
        messageId: itemId,
        blockId: `${itemId}:text:0`,
        blockType: 'text',
        delta
      };
    case 'item/commandExecution/outputDelta':
      return {
        providerId: 'codex',
        conversationKey: handle.threadKey,
        sessionId: handle.sessionId,
        messageId: itemId,
        blockId: `${itemId}:result`,
        blockType: 'tool_result',
        delta
      };
    default:
      return null;
  }
}

function userInputToText(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const normalized = input as { type?: string; text?: string; path?: string; name?: string; url?: string };
  switch (normalized.type) {
    case 'text':
      return normalized.text?.trim() ?? '';
    case 'localImage':
      return normalized.path ? `@${normalized.path}` : '';
    case 'image':
      return normalized.url?.trim() ?? '';
    case 'mention':
      return normalized.path ? `@${normalized.path}` : normalized.name?.trim() ?? '';
    case 'skill':
      return normalized.name?.trim() ? `/skill ${normalized.name.trim()}` : '';
    default:
      return '';
  }
}

function summarizeFileChangeItem(item: Extract<CodexAppServerThreadItem, { type: 'fileChange' }>): string {
  const changesCount = Array.isArray(item.changes) ? item.changes.length : 0;
  if (changesCount <= 0) {
    return `file_change status=${item.status}`;
  }
  return `file_change status=${item.status} files=${changesCount}`;
}

function summarizeDynamicToolContent(
  item: Extract<CodexAppServerThreadItem, { type: 'dynamicToolCall' }>
): string {
  if (!Array.isArray(item.contentItems) || item.contentItems.length === 0) {
    return '';
  }

  return item.contentItems
    .map((contentItem) => {
      if (!contentItem || typeof contentItem !== 'object') {
        return '';
      }
      const normalized = contentItem as { text?: string; imageUrl?: string; type?: string };
      if (typeof normalized.text === 'string' && normalized.text.trim()) {
        return normalized.text.trim();
      }
      if (typeof normalized.imageUrl === 'string' && normalized.imageUrl.trim()) {
        return normalized.imageUrl.trim();
      }
      return normalized.type?.trim() ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function buildCommandExecutionResultText(
  item: Extract<CodexAppServerThreadItem, { type: 'commandExecution' }>
): string {
  const lines: string[] = [];
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
    lines.push(item.aggregatedOutput.trim());
  }
  if (item.exitCode !== null && item.exitCode !== undefined) {
    lines.push(`exitCode=${item.exitCode}`);
  }
  if (item.durationMs !== null && item.durationMs !== undefined) {
    lines.push(`durationMs=${item.durationMs}`);
  }
  return lines.join('\n');
}

function buildTurnErrorText(turn: CodexAppServerTurn): string {
  const errorText = turn.error?.message?.trim() ?? '';
  const detailsText = turn.error?.additionalDetails?.trim() ?? '';
  return [errorText, detailsText].filter(Boolean).join('\n\n');
}

function materializeThreadItemMessages(params: {
  createdAt: string;
  rawItem: CodexAppServerThreadItem | Record<string, unknown>;
  sequence: number;
  status?: MessageStatus;
  turnId: string;
}): ChatMessage[] {
  const item = params.rawItem as CodexAppServerThreadItem;
  const status = params.status ?? 'complete';

  switch (item.type) {
    case 'userMessage': {
      const text = item.content.map(userInputToText).filter(Boolean).join('\n');
      const blocks = createTextBlock(item.id, text);
      if (blocks.length === 0) {
        return [];
      }
      return [
        {
          id: item.id,
          role: 'user',
          blocks,
          meta: {
            phase: null,
            turnId: params.turnId
          },
          status: 'complete',
          createdAt: params.createdAt,
          sequence: params.sequence
        }
      ];
    }
    case 'agentMessage': {
      const blocks = status === 'streaming' ? createRawTextBlock(item.id, item.text) : createTextBlock(item.id, item.text);
      if (blocks.length === 0) {
        return [];
      }
      return [
        {
          id: item.id,
          role: 'assistant',
          blocks,
          meta: {
            phase: item.phase ?? null,
            turnId: params.turnId
          },
          status,
          createdAt: params.createdAt,
          sequence: params.sequence
        }
      ];
    }
    case 'plan': {
      const blocks = status === 'streaming' ? createRawTextBlock(item.id, item.text) : createTextBlock(item.id, item.text);
      if (blocks.length === 0) {
        return [];
      }
      return [
        {
          id: item.id,
          role: 'assistant',
          blocks,
          meta: {
            phase: 'plan',
            turnId: params.turnId
          },
          status,
          createdAt: params.createdAt,
          sequence: params.sequence
        }
      ];
    }
    case 'reasoning': {
      const text = [...item.summary, ...item.content].filter(Boolean).join('\n');
      const blocks = status === 'streaming' ? createRawTextBlock(item.id, text) : createTextBlock(item.id, text);
      if (blocks.length === 0) {
        return [];
      }
      return [
        {
          id: item.id,
          role: 'assistant',
          blocks,
          meta: {
            phase: 'reasoning',
            turnId: params.turnId
          },
          status,
          createdAt: params.createdAt,
          sequence: params.sequence
        }
      ];
    }
    case 'commandExecution':
      return [
        createToolMessage({
          id: item.id,
          toolName: 'command',
          input: item.command,
          result: buildCommandExecutionResultText(item),
          isError: item.status === 'failed' || item.status === 'declined',
          streaming: item.status === 'inProgress' || status === 'streaming',
          createdAt: params.createdAt,
          sequence: params.sequence,
          turnId: params.turnId
        })
      ];
    case 'mcpToolCall': {
      const resultText = item.error?.message?.trim()
        ? item.error.message.trim()
        : stringifyUnknown(item.result ?? '');
      return [
        createToolMessage({
          id: item.id,
          toolName: `${item.server}/${item.tool}`,
          input: stringifyUnknown(item.arguments),
          result: resultText,
          isError: Boolean(item.error?.message?.trim()),
          streaming: item.status === 'inProgress' || status === 'streaming',
          createdAt: params.createdAt,
          sequence: params.sequence,
          turnId: params.turnId
        })
      ];
    }
    case 'dynamicToolCall':
      return [
        createToolMessage({
          id: item.id,
          toolName: item.tool,
          input: stringifyUnknown(item.arguments),
          result: summarizeDynamicToolContent(item),
          isError: item.success === false,
          streaming: item.status === 'inProgress' || status === 'streaming',
          createdAt: params.createdAt,
          sequence: params.sequence,
          turnId: params.turnId
        })
      ];
    case 'webSearch':
      return [
        createToolMessage({
          id: item.id,
          toolName: 'web_search',
          input: item.query,
          result: stringifyUnknown(item.action ?? ''),
          createdAt: params.createdAt,
          sequence: params.sequence,
          turnId: params.turnId,
          streaming: status === 'streaming'
        })
      ];
    case 'fileChange': {
      const blocks =
        status === 'streaming'
          ? createRawTextBlock(item.id, summarizeFileChangeItem(item))
          : createTextBlock(item.id, summarizeFileChangeItem(item));
      if (blocks.length === 0) {
        return [];
      }
      return [
        {
          id: item.id,
          role: 'assistant',
          blocks,
          meta: {
            phase: 'file_change',
            turnId: params.turnId
          },
          status: item.status === 'failed' ? 'error' : item.status === 'inProgress' ? 'streaming' : status,
          createdAt: params.createdAt,
          sequence: params.sequence
        }
      ];
    }
    default: {
      const rawId = typeof params.rawItem.id === 'string' ? params.rawItem.id : null;
      const rawType = typeof params.rawItem.type === 'string' ? params.rawItem.type : null;
      if (!rawId || !rawType) {
        return [];
      }
      const blocks =
        status === 'streaming'
          ? createRawTextBlock(rawId, `[${rawType}] ${stringifyUnknown(params.rawItem)}`)
          : createTextBlock(rawId, `[${rawType}] ${stringifyUnknown(params.rawItem)}`);
      if (blocks.length === 0) {
        return [];
      }
      return [
        {
          id: rawId,
          role: 'assistant',
          blocks,
          meta: {
            phase: rawType,
            turnId: params.turnId
          },
          status,
          createdAt: params.createdAt,
          sequence: params.sequence
        }
      ];
    }
  }
}

function createTurnErrorMessage(params: {
  createdAt: string;
  sequence: number;
  turn: CodexAppServerTurn;
}): ChatMessage | null {
  const errorText = buildTurnErrorText(params.turn);
  const blocks = createTextBlock(`${params.turn.id}:error`, errorText);
  if (blocks.length === 0) {
    return null;
  }

  return {
    id: `${params.turn.id}:error`,
    role: 'assistant',
    blocks,
    meta: {
      phase: 'error',
      turnId: params.turn.id
    },
    status: 'error',
    createdAt: params.createdAt,
    sequence: params.sequence
  };
}

function materializeThreadState(
  thread: CodexAppServerThread,
  snapshotMessagesMax: number
): MaterializedThreadState {
  const allMessages: ChatMessage[] = [];
  let sequence = 0;
  let activeTurnId: string | null = null;
  let lastError: string | null = null;

  for (const turn of thread.turns) {
    if (turn.status === 'inProgress') {
      activeTurnId = turn.id;
    }
    if (turn.status === 'failed' && turn.error?.message?.trim()) {
      lastError = turn.error.message.trim();
    }

    for (const rawItem of turn.items as Array<CodexAppServerThreadItem | Record<string, unknown>>) {
      const createdAt = formatCreatedAt(thread.createdAt, sequence);
      allMessages.push(
        ...materializeThreadItemMessages({
          createdAt,
          rawItem,
          sequence,
          status: turn.status === 'inProgress' ? 'streaming' : 'complete',
          turnId: turn.id
        })
      );
      sequence += 1;
    }

    if (turn.status === 'failed') {
      const turnErrorMessage = createTurnErrorMessage({
        createdAt: formatCreatedAt(thread.createdAt, sequence),
        sequence,
        turn
      });
      if (turnErrorMessage) {
        allMessages.push(turnErrorMessage);
      }
      sequence += 1;
    }
  }

  const hasOlderMessages = allMessages.length > snapshotMessagesMax;
  const messages = hasOlderMessages ? allMessages.slice(-snapshotMessagesMax) : allMessages;
  const threadStatus = thread.status?.type;
  const status: RuntimeStatus =
    threadStatus === 'systemError'
      ? 'error'
      : threadStatus === 'active' || activeTurnId !== null
        ? 'running'
        : 'idle';

  return {
    activeTurnId,
    allMessages,
    hasOlderMessages,
    lastError: status === 'error' ? lastError ?? 'Codex app-server reported a system error' : lastError,
    messages,
    status
  };
}

function summarizeThreadTitle(thread: CodexAppServerThread): { preview: string; title: string } {
  const preview = thread.preview.trim() || thread.name?.trim() || 'Untitled conversation';
  const title = thread.name?.trim() || (preview.length <= 44 ? preview : `${preview.slice(0, 41)}...`);
  return {
    preview,
    title
  };
}

export class CodexAppServerManager {
  private static readonly BACKGROUND_HANDLE_GC_INTERVAL_MS = 5 * 60 * 1000;

  private static readonly BACKGROUND_HANDLE_IDLE_TTL_MS = 5 * 60 * 60 * 1000;

  private readonly callbacks: CodexAppServerCallbacks;

  private readonly client: CodexAppServerClient;

  private readonly handles = new Map<string, CodexAppServerHandle>();

  private readonly options: CodexAppServerRuntimeOptions;

  private activeThreadKey: string | null = null;

  private currentCwd: string;

  private pollTimer: NodeJS.Timeout | null = null;

  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();

  private readonly gcTimer: NodeJS.Timeout;

  private readonly pendingRuntimeRequests = new Map<string | number, PendingRuntimeRequest>();

  private terminalSession: ActiveTerminalSession | null = null;

  private terminalSessionToken = 0;

  private terminalSize: { cols: number; rows: number };

  private terminalVisibilityTarget: {
    conversationKey: string | null;
    sessionId: string | null;
    visible: boolean;
  } = {
    conversationKey: null,
    sessionId: null,
    visible: false
  };

  constructor(options: CodexAppServerRuntimeOptions, callbacks: CodexAppServerCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
    this.currentCwd = options.defaultCwd;
    this.terminalSize = {
      cols: options.terminalCols,
      rows: options.terminalRows
    };
    this.client = new CodexAppServerClient({
      clientInfo: {
        name: 'pty-remote-cli',
        title: 'pty-remote',
        version: '0.1.13'
      },
      cwd: options.defaultCwd,
      env: process.env,
      onNotification: (notification) => {
        this.handleAppServerNotification(notification);
      },
      explicitPort: options.appServerPort,
      onLog: (level, message, details) => {
        this.log(level, message, details);
      },
      onServerRequest: (request) => {
        this.handleServerRequest(request);
      },
      readyTimeoutMs: options.appServerReadyTimeoutMs
    });
    this.gcTimer = setInterval(() => {
      this.gcInactiveHandles();
    }, CodexAppServerManager.BACKGROUND_HANDLE_GC_INTERVAL_MS);
    this.gcTimer.unref();
  }

  private log(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
    const logger = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    if (details) {
      logger(`[pty-remote][codex-app-server] ${message}`, details);
      return;
    }
    logger(`[pty-remote][codex-app-server] ${message}`);
  }

  getRegistrationPayload(): { conversationKey: string | null; cwd: string; sessionId: string | null; supportsTerminal: boolean } {
    const handle = this.getActiveHandle();
    return {
      cwd: handle?.cwd ?? this.currentCwd,
      sessionId: handle?.sessionId ?? null,
      conversationKey: handle?.threadKey ?? null,
      supportsTerminal: true
    };
  }

  updateTerminalSize(cols: number, rows: number): void {
    const nextCols = Number.isFinite(cols) ? Math.max(20, Math.min(Math.floor(cols), 400)) : this.terminalSize.cols;
    const nextRows = Number.isFinite(rows) ? Math.max(8, Math.min(Math.floor(rows), 200)) : this.terminalSize.rows;
    this.terminalSize = {
      cols: nextCols,
      rows: nextRows
    };

    if (!this.terminalSession) {
      return;
    }

    resizeCodexAppServerTerminalSession(this.terminalSession.session, nextCols, nextRows);
    const patch = this.terminalSession.frameState.resize(nextCols, nextRows);
    if (patch) {
      this.callbacks.emitTerminalFramePatch({
        conversationKey: this.terminalSession.conversationKey,
        patch
      });
    }
  }

  listManagedPtyHandles(): ManagedPtyHandleSummary[] {
    if (!this.terminalSession) {
      return [];
    }

    const handle = this.handles.get(this.terminalSession.conversationKey) ?? null;
    return [
      {
        conversationKey: this.terminalSession.conversationKey,
        sessionId: this.terminalSession.sessionId,
        cwd: handle?.cwd ?? this.currentCwd,
        label: handle?.label ?? (handle?.cwd ? path.basename(handle.cwd) : this.currentCwd),
        lifecycle: 'attached',
        hasPty: true,
        lastActivityAt: Date.now()
      }
    ];
  }

  async resolveRuntimeRequest(payload: { error?: string | null; requestId: string | number; result?: unknown }): Promise<void> {
    const pending = this.pendingRuntimeRequests.get(payload.requestId);
    if (!pending) {
      return;
    }
    await this.client.respondToServerRequest(payload.requestId, payload.result, payload.error ?? null);
  }

  private async resumeHandleThread(handle: CodexAppServerHandle): Promise<void> {
    if (!handle.sessionId) {
      return;
    }

    await this.client.request('thread/resume', {
      threadId: handle.sessionId,
      persistExtendedHistory: false
    });
  }

  async setTerminalVisibility(payload: {
    conversationKey: string | null;
    sessionId: string | null;
    visible: boolean;
  }): Promise<void> {
    this.terminalVisibilityTarget = {
      conversationKey: payload.conversationKey ?? null,
      sessionId: payload.sessionId ?? null,
      visible: payload.visible === true
    };

    if (!this.terminalVisibilityTarget.visible || !this.terminalVisibilityTarget.sessionId) {
      this.stopTerminalSession('terminal-hidden');
      return;
    }

    const activeHandle = this.getActiveHandle();
    if (
      !activeHandle ||
      activeHandle.threadKey !== this.terminalVisibilityTarget.conversationKey ||
      activeHandle.sessionId !== this.terminalVisibilityTarget.sessionId
    ) {
      return;
    }

    try {
      await this.ensureTerminalSession(activeHandle);
    } catch (error) {
      this.log('warn', 'failed to attach codex terminal after visibility change', {
        conversationKey: activeHandle.threadKey,
        cwd: activeHandle.cwd,
        error: errorMessage(error, 'Failed to attach Codex terminal'),
        sessionId: activeHandle.sessionId
      });
    }
  }

  async activateConversation(selection: CodexAppServerSelection): Promise<SelectConversationResultPayload> {
    const normalized = await this.normalizeSelection(selection);
    let handle = this.handles.get(normalized.conversationKey);
    if (!handle) {
      handle = this.createHandle(normalized);
      this.handles.set(handle.threadKey, handle);
    } else {
      handle.cwd = normalized.cwd;
      handle.label = normalized.label;
      if (handle.sessionId === null && normalized.sessionId) {
        handle.sessionId = normalized.sessionId;
        handle.runtime.sessionId = normalized.sessionId;
      }
    }

    this.activeThreadKey = handle.threadKey;
    this.currentCwd = handle.cwd;
    this.markHandleActive(handle);

    await this.client.ensureConnected();
    if (handle.sessionId && !handle.initialized) {
      await this.resumeHandleThread(handle);
      await this.refreshHandleFromServer(handle);
    }
    this.emitCurrentMessagesUpsert(handle);
    this.emitRuntimeMeta(handle);
    this.emitPendingRuntimeRequestsForHandle(handle);
    if (
      this.terminalVisibilityTarget.visible &&
      this.terminalVisibilityTarget.conversationKey === handle.threadKey &&
      this.terminalVisibilityTarget.sessionId === handle.sessionId
    ) {
      try {
        await this.ensureTerminalSession(handle);
      } catch (error) {
        this.log('warn', 'failed to attach codex terminal during conversation activation', {
          conversationKey: handle.threadKey,
          cwd: handle.cwd,
          error: errorMessage(error, 'Failed to attach Codex terminal'),
          sessionId: handle.sessionId
        });
      }
    } else if (
      this.terminalSession &&
      this.terminalSession.conversationKey !== handle.threadKey
    ) {
      this.stopTerminalSession('conversation-switched');
    }
    return {
      providerId: 'codex',
      cwd: handle.cwd,
      label: handle.label,
      sessionId: handle.sessionId,
      conversationKey: handle.threadKey
    };
  }

  async hydrateConversation(selection: CodexAppServerSelection & { maxMessages?: number }): Promise<RuntimeSnapshot | null> {
    const maxMessages = selection.maxMessages;
    const normalized = await this.normalizeSelection(selection);
    let handle = this.handles.get(normalized.conversationKey);
    if (!handle) {
      handle = this.createHandle(normalized);
      this.handles.set(handle.threadKey, handle);
    } else {
      handle.cwd = normalized.cwd;
      handle.label = normalized.label;
      handle.sessionId = normalized.sessionId;
      handle.runtime.sessionId = normalized.sessionId;
    }

    this.markHandleActive(handle);
    if (handle.sessionId && !handle.initialized) {
      await this.client.ensureConnected();
      await this.resumeHandleThread(handle);
      await this.refreshHandleFromServer(handle);
    }

    return this.snapshotForHandle(handle, maxMessages);
  }

  async dispatchMessage(content: string): Promise<void> {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new Error('Message cannot be empty');
    }

    const handle = this.getActiveHandle();
    if (!handle) {
      throw new Error('No active thread selected');
    }
    if (handle.runtime.status === 'running' || handle.runtime.status === 'starting') {
      throw new Error('Codex is still handling the previous message');
    }

    await this.client.ensureConnected();
    this.clearLastError(handle);
    this.markHandleActive(handle);

    if (!handle.sessionId) {
      const started = await this.client.request<CodexAppServerThreadStartResponse>('thread/start', {
        approvalPolicy: 'on-request',
        cwd: handle.cwd,
        persistExtendedHistory: false
      });
      handle.sessionId = started.thread.id;
      handle.runtime.sessionId = started.thread.id;
      this.emitRuntimeMeta(handle);
    } else {
      await this.resumeHandleThread(handle);
    }

    let startedTurn: CodexAppServerTurnStartResponse;
    try {
      startedTurn = await this.client.request<CodexAppServerTurnStartResponse>('turn/start', {
        approvalPolicy: 'on-request',
        input: [
          {
            type: 'text',
            text: trimmedContent,
            text_elements: []
          }
        ],
        threadId: handle.sessionId
      });
    } catch (error) {
      if (!isThreadNotFoundError(error) || !handle.sessionId) {
        throw error;
      }
      this.log('warn', 'codex thread was not loaded; retrying turn/start after explicit resume', {
        conversationKey: handle.threadKey,
        cwd: handle.cwd,
        sessionId: handle.sessionId
      });
      await this.resumeHandleThread(handle);
      startedTurn = await this.client.request<CodexAppServerTurnStartResponse>('turn/start', {
        approvalPolicy: 'on-request',
        input: [
          {
            type: 'text',
            text: trimmedContent,
            text_elements: []
          }
        ],
        threadId: handle.sessionId
      });
    }
    handle.activeTurnId = startedTurn.turn.id;
    handle.runtime.status = 'running';
    this.emitRuntimeMeta(handle);
    await this.refreshHandleFromServer(handle);
    if (this.terminalVisibilityTarget.visible && this.terminalVisibilityTarget.sessionId === handle.sessionId) {
      try {
        await this.ensureTerminalSession(handle);
      } catch (error) {
        this.log('warn', 'failed to attach codex terminal after dispatch', {
          conversationKey: handle.threadKey,
          cwd: handle.cwd,
          error: errorMessage(error, 'Failed to attach Codex terminal'),
          sessionId: handle.sessionId
        });
      }
    }
  }

  async stopActiveRun(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle?.sessionId || !handle.activeTurnId) {
      return;
    }

    this.markHandleActive(handle);
    await this.client.ensureConnected();
    await this.client.request('turn/interrupt', {
      threadId: handle.sessionId,
      turnId: handle.activeTurnId
    });
  }

  async resetActiveThread(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }

    handle.sessionId = null;
    handle.activeTurnId = null;
    handle.initialized = false;
    handle.lastActivityAt = Date.now();
    handle.runtime = this.createFreshState(handle.threadKey, null);
    this.stopTerminalSession('reset-thread');
    this.emitRuntimeMeta(handle);
  }

  async sendTerminalInput(input: string): Promise<void> {
    if (!input) {
      return;
    }
    if (!this.terminalSession) {
      throw new Error('Codex terminal session is not attached');
    }
    const handle = this.handles.get(this.terminalSession.conversationKey) ?? null;
    if (handle) {
      this.markHandleActive(handle);
    }
    this.terminalSession.session.pty.write(input);
  }

  async cleanupProject(cwd: string): Promise<void> {
    const normalizedCwd = await this.normalizeProjectCwd(cwd);
    for (const [threadKey, handle] of this.handles.entries()) {
      if (handle.cwd !== normalizedCwd) {
        continue;
      }
      if (this.activeThreadKey === threadKey) {
        this.activeThreadKey = null;
      }
      this.clearScheduledRefresh(handle);
      if (this.terminalSession?.conversationKey === threadKey) {
        this.stopTerminalSession('cleanup-project');
      }
      this.handles.delete(threadKey);
    }
  }

  async cleanupConversation(target: RuntimeCleanupTarget): Promise<void> {
    const normalizedCwd = await this.normalizeProjectCwd(target.cwd);
    for (const [threadKey, handle] of this.handles.entries()) {
      if (handle.cwd !== normalizedCwd) {
        continue;
      }
      if (handle.threadKey !== target.conversationKey && !(target.sessionId && handle.sessionId === target.sessionId)) {
        continue;
      }
      if (this.activeThreadKey === threadKey) {
        this.activeThreadKey = null;
      }
      this.clearScheduledRefresh(handle);
      if (this.terminalSession?.conversationKey === threadKey) {
        this.stopTerminalSession('cleanup-conversation');
      }
      this.handles.delete(threadKey);
    }
  }

  async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    clearInterval(this.gcTimer);
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.stopTerminalSession('shutdown');
    await this.client.close();
  }

  async listProjectConversations(projectRoot: string, maxSessions = 12): Promise<ProjectSessionSummary[]> {
    const normalizedCwd = await this.normalizeProjectCwd(projectRoot);
    await this.client.ensureConnected();
    const response = await this.client.request<CodexAppServerThreadListResponse>('thread/list', {
      archived: false,
      cwd: normalizedCwd,
      limit: Math.max(1, Math.min(Math.floor(maxSessions), 50)),
      sortKey: 'updated_at',
      sourceKinds: ['cli', 'appServer']
    });

    return response.data.map((thread) => {
      const summary = summarizeThreadTitle(thread);
      return {
        providerId: 'codex',
        sessionId: thread.id,
        cwd: thread.cwd,
        title: summary.title,
        preview: summary.preview,
        updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
        messageCount: 0
      };
    });
  }

  private handleAppServerNotification(notification: CodexAppServerNotification): void {
    const params = notification.params as Record<string, unknown> | undefined;
    const threadId = notificationThreadId(notification);

    if (notification.method === 'serverRequest/resolved') {
      const requestId = (params?.requestId as string | number | undefined) ?? null;
      if (requestId !== null) {
        const pending = this.pendingRuntimeRequests.get(requestId);
        if (pending) {
          this.pendingRuntimeRequests.delete(requestId);
          const handle = this.getHandleBySessionId(pending.threadId);
          if (handle) {
            this.markHandleActive(handle);
          }
          this.callbacks.emitRuntimeRequestResolved({
            providerId: 'codex',
            conversationKey: handle?.threadKey ?? pending.threadId,
            sessionId: pending.threadId,
            requestId
          });
        }
      }
      return;
    }

    if (!threadId) {
      return;
    }

    const handle = this.getHandleBySessionId(threadId);
    if (!handle) {
      return;
    }

    const shouldRefreshFromSnapshot = this.applyOptimisticNotification(handle, notification);
    if (shouldRefreshFromSnapshot) {
      this.scheduleRefresh(handle, 0);
    }
  }

  private handleServerRequest(request: CodexAppServerServerRequest): void {
    const params = (request.params ?? null) as Record<string, unknown> | null;
    const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
    if (!threadId) {
      return;
    }

    const pending: PendingRuntimeRequest = {
      requestId: request.id,
      threadId,
      method: request.method,
      params: request.params ?? null
    };
    this.pendingRuntimeRequests.set(request.id, pending);

    const handle = this.getHandleBySessionId(threadId);
    if (handle) {
      this.markHandleActive(handle);
    }

    this.callbacks.emitRuntimeRequest({
      providerId: 'codex',
      conversationKey: handle?.threadKey ?? threadId,
      sessionId: threadId,
      requestId: request.id,
      method: request.method,
      params: request.params ?? null
    });
  }

  private emitPendingRuntimeRequestsForHandle(handle: CodexAppServerHandle): void {
    if (!handle.sessionId) {
      return;
    }
    for (const pending of this.pendingRuntimeRequests.values()) {
      if (pending.threadId !== handle.sessionId) {
        continue;
      }
      this.callbacks.emitRuntimeRequest({
        providerId: 'codex',
        conversationKey: handle.threadKey,
        sessionId: handle.sessionId,
        requestId: pending.requestId,
        method: pending.method,
        params: pending.params
      });
    }
  }

  private async ensureTerminalSession(handle: CodexAppServerHandle): Promise<void> {
    if (!handle.sessionId) {
      return;
    }
    if (
      this.terminalSession &&
      this.terminalSession.sessionId === handle.sessionId &&
      this.terminalSession.conversationKey === handle.threadKey
    ) {
      return;
    }

    this.stopTerminalSession('terminal-reattach');
    const wsUrl = await this.client.getWsUrl();
    const token = ++this.terminalSessionToken;
    const frameState = new HeadlessTerminalFrameState({
      cols: this.terminalSize.cols,
      rows: this.terminalSize.rows,
      maxLines: this.options.terminalFrameScrollback,
      scrollback: this.options.terminalFrameScrollback
    });
    const resetPatch = frameState.reset(handle.sessionId);
    this.callbacks.emitTerminalFramePatch({
      conversationKey: handle.threadKey,
      patch: resetPatch
    });

    const session = startCodexAppServerTerminalSession({
      cols: this.terminalSize.cols,
      cwd: handle.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      },
      rows: this.terminalSize.rows,
      sessionId: handle.sessionId,
      wsUrl,
      onData: (chunk) => {
        if (!this.terminalSession || this.terminalSession.token !== token) {
          return;
        }
        this.markHandleActive(handle);
        void frameState.enqueueOutput(chunk).then((patch) => {
          if (!patch || !this.terminalSession || this.terminalSession.token !== token) {
            return;
          }
          this.callbacks.emitTerminalFramePatch({
            conversationKey: handle.threadKey,
            patch
          });
        });
      },
      onExit: () => {
        if (!this.terminalSession || this.terminalSession.token !== token) {
          return;
        }
        this.stopTerminalSession('terminal-exit');
      }
    });

    this.terminalSession = {
      conversationKey: handle.threadKey,
      frameState,
      session,
      sessionId: handle.sessionId,
      token
    };
  }

  private stopTerminalSession(reason: string): void {
    const current = this.terminalSession;
    if (!current) {
      return;
    }

    this.terminalSession = null;
    current.frameState.dispose();
    stopCodexAppServerTerminalSession(current.session);
    this.callbacks.emitTerminalSessionEvicted({
      conversationKey: current.conversationKey,
      reason,
      sessionId: current.sessionId
    });
  }

  private getActiveHandle(): CodexAppServerHandle | null {
    return this.activeThreadKey ? this.handles.get(this.activeThreadKey) ?? null : null;
  }

  private markHandleActive(handle: CodexAppServerHandle): void {
    handle.lastActivityAt = Date.now();
  }

  private getHandleBySessionId(sessionId: string): CodexAppServerHandle | null {
    for (const handle of this.handles.values()) {
      if (handle.sessionId === sessionId) {
        return handle;
      }
    }

    return null;
  }

  private createHandle(selection: CodexAppServerSelection): CodexAppServerHandle {
    return {
      threadKey: selection.conversationKey,
      cwd: selection.cwd,
      label: selection.label,
      sessionId: selection.sessionId,
      runtime: this.createFreshState(selection.conversationKey, selection.sessionId),
      activeTurnId: null,
      initialized: false,
      lastActivityAt: Date.now()
    };
  }

  private createFreshState(conversationKey: string | null, sessionId: string | null): AgentRuntimeState {
    return {
      providerId: 'codex',
      conversationKey,
      status: 'idle',
      sessionId,
      allMessages: [],
      messages: [],
      hasOlderMessages: false,
      lastError: null
    };
  }

  private snapshotForHandle(handle: CodexAppServerHandle, maxMessages?: number): RuntimeSnapshot {
    const normalizedMaxMessages =
      typeof maxMessages === 'number' && Number.isFinite(maxMessages)
        ? Math.max(1, Math.floor(maxMessages))
        : null;
    const allMessages = normalizedMaxMessages
      ? handle.runtime.allMessages.slice(-normalizedMaxMessages)
      : handle.runtime.messages;
    return cloneValue({
      providerId: 'codex',
      conversationKey: handle.threadKey,
      status: handle.runtime.status,
      sessionId: handle.sessionId,
      messages: allMessages,
      hasOlderMessages: normalizedMaxMessages
        ? handle.runtime.allMessages.length > allMessages.length
        : handle.runtime.hasOlderMessages,
      lastError: handle.runtime.lastError
    } satisfies RuntimeSnapshot);
  }

  private emitRuntimeMeta(handle: CodexAppServerHandle): void {
    this.callbacks.emitRuntimeMeta({
      providerId: 'codex',
      conversationKey: handle.threadKey,
      cwd: handle.cwd,
      lastError: handle.runtime.lastError,
      sessionId: handle.runtime.sessionId,
      status: handle.runtime.status
    });
  }

  private emitCurrentMessagesUpsert(handle: CodexAppServerHandle): void {
    if (handle.runtime.messages.length === 0 && !handle.runtime.hasOlderMessages) {
      return;
    }

    this.callbacks.emitMessagesUpsert({
      providerId: 'codex',
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      upserts: cloneValue(handle.runtime.messages),
      recentMessageIds: handle.runtime.messages.map((message) => message.id),
      hasOlderMessages: handle.runtime.hasOlderMessages
    });
  }

  private recomputeVisibleMessages(handle: CodexAppServerHandle): void {
    handle.runtime.hasOlderMessages = handle.runtime.allMessages.length > this.options.snapshotMessagesMax;
    handle.runtime.messages = handle.runtime.hasOlderMessages
      ? handle.runtime.allMessages.slice(-this.options.snapshotMessagesMax)
      : handle.runtime.allMessages;
  }

  private clearScheduledRefresh(handle: CodexAppServerHandle): void {
    const timer = this.refreshTimers.get(handle.threadKey);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.refreshTimers.delete(handle.threadKey);
  }

  private hasPendingRequestForHandle(handle: CodexAppServerHandle): boolean {
    if (!handle.sessionId) {
      return false;
    }

    for (const pending of this.pendingRuntimeRequests.values()) {
      if (pending.threadId === handle.sessionId) {
        return true;
      }
    }

    return false;
  }

  private isHandleProtectedFromGc(handle: CodexAppServerHandle): boolean {
    if (this.activeThreadKey === handle.threadKey) {
      return true;
    }

    if (this.terminalSession?.conversationKey === handle.threadKey) {
      return true;
    }

    if (handle.runtime.status === 'running' || handle.activeTurnId !== null) {
      return true;
    }

    return this.hasPendingRequestForHandle(handle);
  }

  private gcInactiveHandles(): void {
    const now = Date.now();
    const handlesToDelete = [...this.handles.values()]
      .filter((handle) => !this.isHandleProtectedFromGc(handle))
      .filter((handle) => now - handle.lastActivityAt >= CodexAppServerManager.BACKGROUND_HANDLE_IDLE_TTL_MS)
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt);

    for (const handle of handlesToDelete) {
      this.clearScheduledRefresh(handle);
      this.handles.delete(handle.threadKey);
    }
  }

  private applyOptimisticNotification(handle: CodexAppServerHandle, notification: CodexAppServerNotification): boolean {
    this.markHandleActive(handle);
    handle.initialized = true;
    const deltaPayload = createMessageDeltaPayload(handle, notification);
    const hadMessageBefore = deltaPayload
      ? handle.runtime.allMessages.some((message) => message.id === deltaPayload.messageId)
      : false;
    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;
    const previousStatus = handle.runtime.status;
    const previousLastError = handle.runtime.lastError;

    switch (notification.method) {
      case 'turn/started': {
        const params = notification.params as { turn?: { id?: string } } | undefined;
        handle.activeTurnId = typeof params?.turn?.id === 'string' ? params.turn.id : handle.activeTurnId;
        handle.runtime.status = 'running';
        handle.runtime.lastError = null;
        break;
      }
      case 'turn/completed': {
        const params = notification.params as { turn?: CodexAppServerTurn } | undefined;
        const turn = params?.turn;
        if (turn) {
          if (handle.activeTurnId === turn.id) {
            handle.activeTurnId = null;
          }
          if (turn.status === 'failed') {
            handle.runtime.status = 'error';
            handle.runtime.lastError = turn.error?.message?.trim() ?? 'Codex turn failed';
            const turnErrorMessage = createTurnErrorMessage({
              createdAt: new Date().toISOString(),
              sequence: nextSyntheticSequence(handle.runtime.allMessages),
              turn
            });
            if (turnErrorMessage) {
              handle.runtime.allMessages = mergeMessages(handle.runtime.allMessages, [turnErrorMessage]);
            }
          } else {
            handle.runtime.status = 'idle';
            handle.runtime.lastError = null;
          }
        }
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const params = notification.params as {
          item?: CodexAppServerThreadItem | Record<string, unknown>;
          turnId?: string;
        } | undefined;
        if (params?.item && typeof params.turnId === 'string') {
          const upserts = materializeThreadItemMessages({
            createdAt: new Date().toISOString(),
            rawItem: params.item,
            sequence: nextSyntheticSequence(handle.runtime.allMessages),
            status: notification.method === 'item/started' ? 'streaming' : 'complete',
            turnId: params.turnId
          });
          handle.runtime.allMessages = mergeMessages(handle.runtime.allMessages, upserts);
        }
        break;
      }
      default: {
        const nextAllMessages = applyNotificationDelta(handle.runtime.allMessages, notification);
        if (nextAllMessages !== handle.runtime.allMessages) {
          handle.runtime.allMessages = nextAllMessages;
        }
      }
    }

    this.recomputeVisibleMessages(handle);

    const messagesChanged = !messagesEqual(previousMessages, handle.runtime.messages);
    const hasOlderChanged = previousHasOlderMessages !== handle.runtime.hasOlderMessages;

    if (deltaPayload && hadMessageBefore) {
      this.callbacks.emitMessageDelta(deltaPayload);
    } else if (messagesChanged || hasOlderChanged) {
      this.emitCurrentMessagesUpsert(handle);
    }

    if (previousStatus !== handle.runtime.status || previousLastError !== handle.runtime.lastError) {
      this.emitRuntimeMeta(handle);
    }

    return notification.method === 'turn/completed';
  }

  private clearLastError(handle: CodexAppServerHandle): void {
    if (handle.runtime.lastError === null && handle.runtime.status !== 'error') {
      return;
    }
    handle.runtime.lastError = null;
    if (handle.runtime.status === 'error') {
      handle.runtime.status = 'idle';
    }
    this.emitRuntimeMeta(handle);
  }

  private async normalizeSelection(selection: CodexAppServerSelection): Promise<CodexAppServerSelection> {
    const cwd = await this.normalizeProjectCwd(selection.cwd);
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      throw new Error('Selected project is not a directory');
    }

    return {
      cwd,
      label: selection.label.trim() || path.basename(cwd) || cwd,
      sessionId: selection.sessionId,
      conversationKey: selection.conversationKey
    };
  }

  private async normalizeProjectCwd(cwd: string): Promise<string> {
    const resolvedCwd = path.resolve(cwd);
    return await fs.realpath(resolvedCwd).catch(() => resolvedCwd);
  }

  private async refreshHandleFromServer(handle: CodexAppServerHandle): Promise<void> {
    if (!handle.sessionId) {
      return;
    }
    this.clearScheduledRefresh(handle);
    this.markHandleActive(handle);

    const previousAllMessages = handle.runtime.allMessages;
    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;
    const previousStatus = handle.runtime.status;
    const previousLastError = handle.runtime.lastError;
    const previousSessionId = handle.runtime.sessionId;

    let response: CodexAppServerThreadReadResponse;
    try {
      response = await this.client.request<CodexAppServerThreadReadResponse>('thread/read', {
        threadId: handle.sessionId,
        includeTurns: true
      });
    } catch (error) {
      if (!isThreadNotMaterializedYetError(error)) {
        throw error;
      }
      this.log('info', 'codex thread not materialized yet; deferring includeTurns refresh', {
        conversationKey: handle.threadKey,
        cwd: handle.cwd,
        sessionId: handle.sessionId
      });
      return;
    }
    const nextState = materializeThreadState(response.thread, this.options.snapshotMessagesMax);
    const runningTurnId = nextState.activeTurnId ?? handle.activeTurnId;
    const nextAllMessages =
      nextState.status === 'running'
        ? reconcileRunningTurnMessages(previousAllMessages, nextState.allMessages, runningTurnId)
        : nextState.allMessages;
    const nextHasOlderMessages = nextAllMessages.length > this.options.snapshotMessagesMax;
    const nextMessages = nextHasOlderMessages
      ? nextAllMessages.slice(-this.options.snapshotMessagesMax)
      : nextAllMessages;

    handle.activeTurnId = nextState.activeTurnId;
    handle.runtime.allMessages = nextAllMessages;
    handle.runtime.messages = nextMessages;
    handle.runtime.hasOlderMessages = nextHasOlderMessages;
    handle.runtime.status = nextState.status;
    handle.runtime.lastError = nextState.lastError;
    handle.runtime.sessionId = handle.sessionId;
    handle.initialized = true;

    const allMessagesChanged = !messagesEqual(previousAllMessages, nextAllMessages);
    const messagesChanged = !messagesEqual(previousMessages, nextMessages);
    const hasOlderChanged = previousHasOlderMessages !== nextHasOlderMessages;
    const statusChanged = previousStatus !== nextState.status;
    const lastErrorChanged = previousLastError !== nextState.lastError;

    if (allMessagesChanged || messagesChanged || hasOlderChanged) {
      this.callbacks.emitMessagesUpsert({
        providerId: 'codex',
        conversationKey: handle.threadKey,
        sessionId: handle.sessionId,
        upserts: cloneValue(nextMessages),
        recentMessageIds: nextMessages.map((message) => message.id),
        hasOlderMessages: nextHasOlderMessages
      });
    }

    if (statusChanged || lastErrorChanged || previousSessionId !== handle.sessionId) {
      this.emitRuntimeMeta(handle);
    }
  }

  private scheduleRefresh(handle: CodexAppServerHandle, delayMs: number): void {
    this.clearScheduledRefresh(handle);
    if (!handle.sessionId) {
      return;
    }

    const timer = setTimeout(() => {
      this.refreshTimers.delete(handle.threadKey);
      const currentHandle = this.handles.get(handle.threadKey) ?? null;
      if (!currentHandle?.sessionId) {
        return;
      }

      void this.refreshHandleFromServer(currentHandle)
        .catch((error) => {
          currentHandle.runtime.lastError = errorMessage(error, 'Failed to refresh Codex app-server thread');
          currentHandle.runtime.status = 'error';
          this.emitRuntimeMeta(currentHandle);
        });
    }, Math.max(0, delayMs));
    timer.unref();
    this.refreshTimers.set(handle.threadKey, timer);
  }
}
