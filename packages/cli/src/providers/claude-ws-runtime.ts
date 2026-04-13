import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type {
  ManagedPtyHandleSummary,
  MessageDeltaPayload,
  RuntimeMetaPayload,
  RuntimeRequestPayload,
  RuntimeRequestResolvedPayload,
  SelectConversationResultPayload,
  TerminalFramePatchPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type {
  ChatMessage,
  ChatMessageBlock,
  ProviderId,
  RuntimeTransientNotice,
  RuntimeSnapshot,
  RuntimeStatus,
  TextChatMessageBlock,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { createClaudeShellExecConfig } from '../cli/claude-shell.ts';
import { parseClaudeJsonlMessages, resolveClaudeJsonlFilePath } from '../cli/jsonl.ts';
import {
  resizeClaudePtySession,
  startClaudePtySession,
  stopClaudePtySession,
  type ClaudePtySession
} from '../cli/pty.ts';
import { HeadlessTerminalFrameState } from '../terminal/frame-state.ts';

import {
  preferIncomingSessionId,
  resolveTerminalVisibilityTarget,
  type ProviderRuntimeCallbacks,
  type ProviderRuntimeSelection
} from './provider-runtime.ts';

export interface ClaudeWsRuntimeOptions {
  defaultCwd: string;
  permissionMode: string;
  snapshotMessagesMax: number;
  claudeReadyTimeoutMs: number;
  gcIntervalMs: number;
  terminalCols: number;
  terminalRows: number;
  terminalFrameScrollback: number;
  model?: string | null;
  verbose?: boolean;
}

const CLAUDE_WARM_HANDLE_TTL_MS = 5 * 60 * 60 * 1000;
const CLAUDE_MAX_WARM_HANDLES = 5;
const CLAUDE_RETRYING_NOTICE_PATTERN = /\b(retry(?:ing)?|reconnect(?:ing)?|connection\s+lost|network\s+error|temporar(?:y|ily)\s+unavailable)\b/i;

interface ClaudeTextContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeToolUseContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeToolResultContentBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

type ClaudeContentBlock = ClaudeTextContentBlock | ClaudeToolUseContentBlock | ClaudeToolResultContentBlock;

interface ClaudeAssistantEnvelope {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ClaudeContentBlock[];
    stop_reason?: string | null;
  };
}

interface ClaudeControlRequestEnvelope {
  type?: string;
  request_id?: string | number;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: unknown;
    message?: string;
    requested_schema?: unknown;
  };
}

interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  result?: string;
}

interface ClaudeSystemEnvelope {
  type?: string;
  subtype?: string;
  model?: string;
  permissionMode?: string;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number;
  error?: string;
  session_id?: string;
}

interface ClaudeStreamEventMessageStart {
  type: 'message_start';
  message?: {
    id?: string;
  };
}

interface ClaudeStreamEventContentBlockDelta {
  type: 'content_block_delta';
  index?: number;
  delta?: {
    type?: string;
    text?: string;
  };
}

interface ClaudeStreamEventMessageStop {
  type: 'message_stop';
}

type ClaudeStreamEvent =
  | ClaudeStreamEventMessageStart
  | ClaudeStreamEventContentBlockDelta
  | ClaudeStreamEventMessageStop;

interface ClaudeStreamEventEnvelope {
  type?: string;
  event?: ClaudeStreamEvent;
  parent_tool_use_id?: string | null;
}

interface AgentRuntimeState extends RuntimeSnapshot {
  allMessages: ChatMessage[];
}

interface ClaudeActiveAssistantStreamState {
  messageId: string;
  textBlockIndices: number[];
}

interface ClaudeWsConnection {
  activeAssistantStatesByScope: Map<string, ClaudeActiveAssistantStreamState>;
  child: ChildProcess | null;
  closed: boolean;
  hostToken: string;
  pendingLines: string[];
  socket: WebSocket | null;
  socketBuffer: string;
  stopRequested: boolean;
}

interface ClaudeWsHostPendingConnection {
  connection: ClaudeWsConnection;
  handle: ClaudeWsHandle;
  reject: (error: Error) => void;
  resolve: () => void;
  timeout: NodeJS.Timeout;
}

interface ClaudeWsHost {
  pendingConnections: Map<string, ClaudeWsHostPendingConnection>;
  port: number;
  sdkPath: string;
  server: http.Server;
  wsServer: WebSocketServer;
}

interface ClaudeWsHandle {
  threadKey: string;
  cwd: string;
  label: string;
  initialized: boolean;
  lastActivityAt: number | null;
  launchPromise: Promise<void> | null;
  runtime: AgentRuntimeState;
  sessionId: string | null;
  sessionEstablished: boolean;
  connection: ClaudeWsConnection | null;
}

interface PendingRuntimeRequest {
  conversationKey: string;
  params: unknown;
  requestId: string | number;
  sessionId: string | null;
  subtype: string;
}

interface ActiveTerminalSession {
  conversationKey: string;
  frameState: HeadlessTerminalFrameState;
  session: ClaudePtySession;
  sessionId: string;
  token: number;
}

type OutboundMessageDeltaPayload = Omit<MessageDeltaPayload, 'cliId'>;

function streamScopeKey(parentToolUseId: string | null | undefined): string {
  return parentToolUseId?.trim() || '';
}

function resolveStreamingTextBlockIndex(
  state: ClaudeActiveAssistantStreamState,
  rawBlockIndex: number
): number {
  const existingIndex = state.textBlockIndices.indexOf(rawBlockIndex);
  if (existingIndex >= 0) {
    return existingIndex;
  }
  state.textBlockIndices.push(rawBlockIndex);
  return state.textBlockIndices.length - 1;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function sameTransientNotice(
  left: RuntimeTransientNotice | null | undefined,
  right: RuntimeTransientNotice | null | undefined
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.message === right?.message &&
    left?.details === right?.details &&
    left?.retrying === right?.retrying
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function createTextBlock(baseId: string, text: string, index = 0): TextChatMessageBlock | null {
  const normalizedText = text.trimEnd();
  if (!normalizedText.trim()) {
    return null;
  }
  return {
    id: `${baseId}:text:${index}`,
    type: 'text',
    text: normalizedText
  };
}

function createToolUseBlock(baseId: string, block: ClaudeToolUseContentBlock, index: number): ToolUseChatMessageBlock {
  return {
    id: block.id ? `tool:${block.id}:use` : `${baseId}:tool_use:${index}`,
    type: 'tool_use',
    toolCallId: block.id,
    toolName: block.name?.trim() || 'unknown',
    input: stringifyUnknown(block.input)
  };
}

function createToolResultBlock(baseId: string, block: ClaudeToolResultContentBlock, index: number): ToolResultChatMessageBlock {
  return {
    id: block.tool_use_id ? `tool:${block.tool_use_id}:result:${index}` : `${baseId}:tool_result:${index}`,
    type: 'tool_result',
    toolCallId: block.tool_use_id,
    content: stringifyUnknown(block.content),
    isError: Boolean(block.is_error)
  };
}

function isTextContentBlock(block: ClaudeContentBlock): block is ClaudeTextContentBlock {
  return block.type === 'text' && 'text' in block && typeof block.text === 'string';
}

function isToolUseContentBlock(block: ClaudeContentBlock): block is ClaudeToolUseContentBlock {
  return block.type === 'tool_use';
}

function isToolResultContentBlock(block: ClaudeContentBlock): block is ClaudeToolResultContentBlock {
  return block.type === 'tool_result';
}

function hasVisibleBlocks(blocks: ChatMessageBlock[]): boolean {
  return blocks.some((block) => {
    switch (block.type) {
      case 'text':
        return Boolean(block.text.trim());
      case 'tool_use':
        return Boolean(block.toolName || block.input);
      case 'tool_result':
        return Boolean(block.content.trim());
      default:
        return false;
    }
  });
}

function blocksEqual(left: ChatMessageBlock[], right: ChatMessageBlock[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((block, index) => {
    const next = right[index];
    if (!next || block.id !== next.id || block.type !== next.type) {
      return false;
    }
    if (block.type === 'text' && next.type === 'text') {
      return block.text === next.text;
    }
    if (block.type === 'tool_use' && next.type === 'tool_use') {
      return block.toolCallId === next.toolCallId && block.toolName === next.toolName && block.input === next.input;
    }
    if (block.type === 'tool_result' && next.type === 'tool_result') {
      return block.toolCallId === next.toolCallId && block.content === next.content && block.isError === next.isError;
    }
    return false;
  });
}

function messagesEqual(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => messageEqual(message, right[index]));
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
    blocksEqual(left.blocks, right.blocks)
  );
}

function extractContentBlocks(baseId: string, rawContent: string | ClaudeContentBlock[] | undefined): ChatMessageBlock[] {
  if (typeof rawContent === 'string') {
    const textBlock = createTextBlock(baseId, rawContent);
    return textBlock ? [textBlock] : [];
  }

  if (!Array.isArray(rawContent)) {
    return [];
  }

  const blocks: ChatMessageBlock[] = [];
  for (const [index, block] of rawContent.entries()) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (isTextContentBlock(block)) {
      const textBlock = createTextBlock(baseId, block.text ?? '', index);
      if (textBlock) {
        blocks.push(textBlock);
      }
      continue;
    }

    if (isToolUseContentBlock(block)) {
      blocks.push(createToolUseBlock(baseId, block, index));
      continue;
    }

    if (isToolResultContentBlock(block)) {
      blocks.push(createToolResultBlock(baseId, block, index));
    }
  }

  return blocks;
}

function deriveMessageStatus(blocks: ChatMessageBlock[], fallback: ChatMessage['status'] = 'complete'): ChatMessage['status'] {
  if (blocks.some((block) => block.type === 'tool_result' && block.isError)) {
    return 'error';
  }
  return fallback;
}

function mergeMessageBlocks(existingBlocks: ChatMessageBlock[], nextBlocks: ChatMessageBlock[]): ChatMessageBlock[] {
  if (existingBlocks.length === 0) {
    return nextBlocks;
  }
  if (nextBlocks.length === 0) {
    return existingBlocks;
  }
  const mergedBlocks = existingBlocks.slice();
  const blockIndexById = new Map(mergedBlocks.map((block, index) => [block.id, index]));
  for (const block of nextBlocks) {
    const existingIndex = blockIndexById.get(block.id);
    if (existingIndex === undefined) {
      blockIndexById.set(block.id, mergedBlocks.length);
      mergedBlocks.push(block);
      continue;
    }
    mergedBlocks[existingIndex] = block;
  }
  return mergedBlocks;
}

function mergeMessages(baseMessages: ChatMessage[], upserts: ChatMessage[]): ChatMessage[] {
  if (upserts.length === 0) {
    return baseMessages;
  }

  const messagesById = new Map(baseMessages.map((message) => [message.id, message]));
  const order = baseMessages.map((message) => message.id);

  for (const upsert of upserts) {
    const existing = messagesById.get(upsert.id);
    const nextBlocks = hasVisibleBlocks(upsert.blocks) ? mergeMessageBlocks(existing?.blocks ?? [], upsert.blocks) : (existing?.blocks ?? []);
    if (!hasVisibleBlocks(nextBlocks)) {
      continue;
    }

    const merged: ChatMessage = {
      id: upsert.id,
      role: upsert.role,
      blocks: nextBlocks,
      status: upsert.status === 'error' ? 'error' : deriveMessageStatus(nextBlocks, upsert.status),
      createdAt: existing?.createdAt ?? upsert.createdAt,
      sequence: existing?.sequence ?? upsert.sequence
    };
    messagesById.set(upsert.id, merged);
    if (!existing) {
      order.push(upsert.id);
    }
  }

  return order
    .map((messageId) => messagesById.get(messageId))
    .filter(Boolean)
    .sort(
      (left, right) =>
        new Date(left!.createdAt).getTime() - new Date(right!.createdAt).getTime() ||
        (left!.sequence ?? 0) - (right!.sequence ?? 0) ||
        left!.id.localeCompare(right!.id)
    ) as ChatMessage[];
}

function createTextDeltaPayload(params: {
  conversationKey: string;
  sessionId: string | null;
  messageId: string;
  blockId: string;
  delta: string;
}): OutboundMessageDeltaPayload {
  return {
    providerId: 'claude',
    conversationKey: params.conversationKey,
    sessionId: params.sessionId,
    messageId: params.messageId,
    blockId: params.blockId,
    blockType: 'text',
    delta: params.delta
  };
}

function createToolResultDeltaPayload(params: {
  conversationKey: string;
  sessionId: string | null;
  messageId: string;
  blockId: string;
  delta: string;
}): OutboundMessageDeltaPayload {
  return {
    providerId: 'claude',
    conversationKey: params.conversationKey,
    sessionId: params.sessionId,
    messageId: params.messageId,
    blockId: params.blockId,
    blockType: 'tool_result',
    delta: params.delta
  };
}

function createAppendOnlyDeltaPayload(
  handle: Pick<ClaudeWsHandle, 'threadKey' | 'sessionId'>,
  messageId: string,
  previousBlock: ChatMessageBlock | null,
  nextBlock: ChatMessageBlock
): OutboundMessageDeltaPayload | null | false {
  if (nextBlock.type === 'tool_use') {
    if (previousBlock?.type !== 'tool_use') {
      return false;
    }
    return previousBlock.toolCallId === nextBlock.toolCallId &&
        previousBlock.toolName === nextBlock.toolName &&
        previousBlock.input === nextBlock.input
      ? null
      : false;
  }

  if (!previousBlock) {
    if (nextBlock.type === 'text') {
      return nextBlock.text
        ? createTextDeltaPayload({
            conversationKey: handle.threadKey,
            sessionId: handle.sessionId,
            messageId,
            blockId: nextBlock.id,
            delta: nextBlock.text
          })
        : null;
    }
    if (nextBlock.isError) {
      return false;
    }
    return nextBlock.content
      ? createToolResultDeltaPayload({
          conversationKey: handle.threadKey,
          sessionId: handle.sessionId,
          messageId,
          blockId: nextBlock.id,
          delta: nextBlock.content
        })
      : null;
  }

  if (previousBlock.type !== nextBlock.type) {
    return false;
  }

  if (nextBlock.type === 'text' && previousBlock.type === 'text') {
    if (nextBlock.text === previousBlock.text) {
      return null;
    }
    if (!nextBlock.text.startsWith(previousBlock.text)) {
      return false;
    }
    const delta = nextBlock.text.slice(previousBlock.text.length);
    return delta
      ? createTextDeltaPayload({
          conversationKey: handle.threadKey,
          sessionId: handle.sessionId,
          messageId,
          blockId: nextBlock.id,
          delta
        })
      : null;
  }

  if (nextBlock.type === 'tool_result' && previousBlock.type === 'tool_result') {
    if (nextBlock.isError !== previousBlock.isError) {
      return false;
    }
    if (nextBlock.content === previousBlock.content) {
      return null;
    }
    if (!nextBlock.content.startsWith(previousBlock.content)) {
      return false;
    }
    const delta = nextBlock.content.slice(previousBlock.content.length);
    return delta
      ? createToolResultDeltaPayload({
          conversationKey: handle.threadKey,
          sessionId: handle.sessionId,
          messageId,
          blockId: nextBlock.id,
          delta
        })
      : null;
  }

  return false;
}

function createAppendOnlyMessageDeltaPayloads(
  handle: Pick<ClaudeWsHandle, 'threadKey' | 'sessionId'>,
  previousMessage: ChatMessage | undefined,
  nextMessage: ChatMessage
): OutboundMessageDeltaPayload[] | null {
  if (!previousMessage) {
    return null;
  }
  if (previousMessage.role !== 'assistant' || nextMessage.role !== 'assistant') {
    return null;
  }
  if (previousMessage.status !== 'streaming' || nextMessage.status !== 'streaming') {
    return null;
  }

  const previousBlockById = new Map(previousMessage.blocks.map((block) => [block.id, block]));
  const payloads: OutboundMessageDeltaPayload[] = [];
  let previousIndex = 0;

  for (const nextBlock of nextMessage.blocks) {
    const previousBlock = previousMessage.blocks[previousIndex];
    if (previousBlock?.id === nextBlock.id) {
      const payload = createAppendOnlyDeltaPayload(handle, nextMessage.id, previousBlock, nextBlock);
      if (payload === false) {
        return null;
      }
      if (payload) {
        payloads.push(payload);
      }
      previousIndex += 1;
      continue;
    }

    if (previousBlockById.has(nextBlock.id) || previousIndex !== previousMessage.blocks.length) {
      return null;
    }

    const payload = createAppendOnlyDeltaPayload(handle, nextMessage.id, null, nextBlock);
    if (payload === false) {
      return null;
    }
    if (payload) {
      payloads.push(payload);
    }
  }

  if (previousIndex !== previousMessage.blocks.length) {
    return null;
  }

  return payloads;
}

function createStreamingMessageDeltaPayloads(
  handle: Pick<ClaudeWsHandle, 'threadKey' | 'sessionId'>,
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
  previousHasOlderMessages: boolean,
  nextHasOlderMessages: boolean
): OutboundMessageDeltaPayload[] | null {
  if (previousHasOlderMessages !== nextHasOlderMessages) {
    return null;
  }

  const previousMessagesById = new Map(previousMessages.map((message) => [message.id, message]));
  const changedMessages = nextMessages.filter((message) => !messageEqual(previousMessagesById.get(message.id), message));
  if (changedMessages.length !== 1) {
    return null;
  }

  return createAppendOnlyMessageDeltaPayloads(handle, previousMessagesById.get(changedMessages[0]!.id), changedMessages[0]!);
}

function finalizeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || message.status !== 'streaming') {
      return message;
    }
    return {
      ...message,
      status: deriveMessageStatus(message.blocks, 'complete')
    };
  });
}

function selectRecentMessages(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  return messages.slice(-maxMessages);
}

function createUserTextMessage(id: string, text: string, createdAt: string, sequence: number): ChatMessage {
  return {
    id,
    role: 'user',
    blocks: createTextBlock(id, text) ? [createTextBlock(id, text)!] : [],
    status: 'complete',
    createdAt,
    sequence
  };
}

function normalizeMaxMessages(maxMessages: number | undefined, fallback: number): number {
  if (typeof maxMessages !== 'number' || !Number.isFinite(maxMessages)) {
    return fallback;
  }
  return Math.max(1, Math.floor(maxMessages));
}

function parseNdjsonChunk(chunk: string, carry = ''): { lines: string[]; rest: string } {
  let buffer = carry + chunk;
  const lines: string[] = [];
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) {
      break;
    }
    lines.push(buffer.slice(0, newlineIndex));
    buffer = buffer.slice(newlineIndex + 1);
  }
  return {
    lines,
    rest: buffer
  };
}

function claudeRuntimeRequestMethod(subtype: string): string {
  switch (subtype) {
    case 'can_use_tool':
      return 'item/tool/requestApproval';
    case 'elicitation':
      return 'item/tool/requestStructuredInput';
    default:
      return `item/tool/${subtype}`;
  }
}

export class ClaudeWsManager {
  private readonly providerId: ProviderId = 'claude';

  private readonly handles = new Map<string, ClaudeWsHandle>();

  private readonly callbacks: ProviderRuntimeCallbacks;

  private readonly options: ClaudeWsRuntimeOptions;

  private readonly pendingRuntimeRequests = new Map<string | number, PendingRuntimeRequest>();

  private host: ClaudeWsHost | null = null;

  private hostPromise: Promise<ClaudeWsHost> | null = null;

  private prunePromise: Promise<void> | null = null;

  private readonly gcTimer: NodeJS.Timeout;

  private activeThreadKey: string | null = null;

  private currentCwd: string;

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

  constructor(options: ClaudeWsRuntimeOptions, callbacks: ProviderRuntimeCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
    this.currentCwd = options.defaultCwd;
    this.terminalSize = {
      cols: options.terminalCols,
      rows: options.terminalRows
    };
    this.gcTimer = setInterval(() => {
      void this.pruneWarmHandles('timer');
    }, Math.max(1_000, options.gcIntervalMs));
    this.gcTimer.unref();
  }

  private log(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
    const logger = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    if (details) {
      logger(`[pty-remote][claude-ws] ${message}`, details);
      return;
    }
    logger(`[pty-remote][claude-ws] ${message}`);
  }

  private setRetryingNotice(handle: ClaudeWsHandle, message: string, details?: string | null): void {
    const nextNotice: RuntimeTransientNotice = {
      kind: 'warning',
      message: message.trim() || 'Claude is retrying...',
      details: details?.trim() || null,
      retrying: true
    };
    if (sameTransientNotice(handle.runtime.transientNotice, nextNotice)) {
      this.log('info', 'claude retrying notice unchanged', {
        conversationKey: handle.threadKey,
        message: nextNotice.message,
        sessionId: handle.sessionId
      });
      return;
    }
    handle.runtime.transientNotice = nextNotice;
    this.log('warn', 'claude retrying notice set', {
      conversationKey: handle.threadKey,
      details: nextNotice.details,
      message: nextNotice.message,
      sessionId: handle.sessionId
    });
    this.emitRuntimeMeta(handle);
  }

  private clearTransientNotice(handle: ClaudeWsHandle, reason = 'unknown'): void {
    if (!handle.runtime.transientNotice) {
      return;
    }
    this.log('info', 'claude transient notice cleared', {
      conversationKey: handle.threadKey,
      previousNotice: handle.runtime.transientNotice,
      reason,
      sessionId: handle.sessionId
    });
    handle.runtime.transientNotice = null;
    this.emitRuntimeMeta(handle);
  }

  private maybeCaptureRetryingNotice(handle: ClaudeWsHandle, text: string): void {
    const trimmed = text.trim();
    const matched = Boolean(trimmed) && CLAUDE_RETRYING_NOTICE_PATTERN.test(trimmed);
    this.log(matched ? 'warn' : 'info', 'claude stderr inspected for retrying state', {
      chunk: trimmed,
      conversationKey: handle.threadKey,
      matched,
      sessionId: handle.sessionId
    });
    if (!matched) {
      return;
    }
    this.setRetryingNotice(handle, trimmed);
  }

  getRegistrationPayload(): {
    cwd: string;
    sessionId: string | null;
    conversationKey: string | null;
    supportsTerminal: boolean;
  } {
    const handle = this.getActiveHandle();
    return {
      cwd: handle?.cwd ?? this.currentCwd,
      sessionId: handle?.sessionId ?? null,
      conversationKey: handle?.threadKey ?? null,
      supportsTerminal: true
    };
  }

  async activateConversation(selection: ProviderRuntimeSelection): Promise<SelectConversationResultPayload> {
    const handle = await this.resolveHandleForSelection(selection);

    if (handle.sessionId) {
      await this.hydrateHandleFromJsonl(handle, this.options.snapshotMessagesMax);
    }

    this.touchHandle(handle);
    this.activeThreadKey = handle.threadKey;
    this.currentCwd = handle.cwd;
    this.emitCurrentMessagesUpsert(handle);
    this.emitRuntimeMeta(handle);
    this.emitPendingRuntimeRequestsForHandle(handle);
    await this.maybeEnsureVisibleTerminalSession(handle);
    await this.pruneWarmHandles('activate');

    return {
      providerId: 'claude',
      cwd: handle.cwd,
      label: handle.label,
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId
    };
  }

  async hydrateConversation(selection: ProviderRuntimeSelection & { maxMessages?: number }): Promise<RuntimeSnapshot | null> {
    const maxMessages = selection.maxMessages;
    const handle = await this.resolveHandleForSelection(selection);

    if (handle.sessionId) {
      await this.hydrateHandleFromJsonl(handle, maxMessages);
    }

    this.touchHandle(handle);
    await this.pruneWarmHandles('hydrate');
    return this.snapshotForHandle(handle, maxMessages);
  }

  async dispatchMessage(content: string, _clientMessageId: string, selection: ProviderRuntimeSelection): Promise<void> {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new Error('Message cannot be empty');
    }

    const handle = await this.resolveHandleForSelection(selection);
    if (handle.sessionId && !handle.initialized) {
      await this.hydrateHandleFromJsonl(handle, this.options.snapshotMessagesMax);
    }
    this.activeThreadKey = handle.threadKey;
    this.currentCwd = handle.cwd;
    if (handle.runtime.status === 'running' || handle.runtime.status === 'starting') {
      throw new Error('Claude is still handling the previous message');
    }

    this.clearLastError(handle);
    if (!handle.sessionId) {
      handle.sessionId = randomUUID();
      handle.runtime.sessionId = handle.sessionId;
      handle.sessionEstablished = false;
      this.emitRuntimeMeta(handle);
    }

    this.touchHandle(handle);
    const nextSequence = this.nextSequence(handle.runtime.allMessages);
    const createdAt = new Date().toISOString();
    this.mergeHandleMessages(handle, [
      createUserTextMessage(`claude:user:${handle.sessionId}:${nextSequence}`, trimmedContent, createdAt, nextSequence)
    ]);

    handle.runtime.status = 'starting';
    this.emitRuntimeMeta(handle);
    await this.ensureHandleConnection(handle);
    this.queueMessage(handle, {
      type: 'user',
      session_id: handle.sessionId,
      message: {
        role: 'user',
        content: trimmedContent
      },
      parent_tool_use_id: null
    });
    handle.runtime.status = 'running';
    this.emitRuntimeMeta(handle);
    await this.pruneWarmHandles('dispatch');
  }

  async resolveRuntimeRequest(payload: { error?: string | null; requestId: string | number; result?: unknown }): Promise<void> {
    const pending = this.pendingRuntimeRequests.get(payload.requestId);
    if (!pending) {
      return;
    }

    const handle = this.handles.get(pending.conversationKey) ?? null;
    if (!handle) {
      return;
    }
    this.touchHandle(handle);

    let response: unknown;
    if (pending.subtype === 'can_use_tool') {
      const result = (payload.result ?? null) as { behavior?: string; message?: string } | null;
      response = {
        behavior: result?.behavior === 'deny' ? 'deny' : 'allow',
        ...(typeof result?.message === 'string' && result.message.trim() ? { message: result.message.trim() } : {})
      };
    } else if (pending.subtype === 'elicitation') {
      const result = payload.result as { action?: string; content?: unknown } | undefined;
      response = result?.action === 'submit'
        ? {
            action: 'submit',
            content: result.content ?? null
          }
        : {
            action: 'cancel'
          };
    } else {
      response = payload.result ?? null;
    }

    this.queueMessage(handle, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: payload.requestId,
        response
      }
    });
    this.pendingRuntimeRequests.delete(payload.requestId);
    this.callbacks.emitRuntimeRequestResolved({
      providerId: 'claude',
      conversationKey: pending.conversationKey,
      sessionId: pending.sessionId,
      requestId: payload.requestId
    } satisfies Omit<RuntimeRequestResolvedPayload, 'cliId'>);
  }

  async resetActiveThread(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }

    if (this.terminalSession?.conversationKey === handle.threadKey) {
      this.stopTerminalSession('reset-thread');
    }
    await this.stopHandleConnection(handle, 'reset-thread');
    handle.sessionId = null;
    handle.sessionEstablished = false;
    handle.runtime = this.createFreshState(handle.threadKey, null);
    this.emitRuntimeMeta(handle);
  }

  async cleanupProject(cwd: string): Promise<void> {
    const normalizedCwd = await this.normalizeProjectCwd(cwd);
    for (const [threadKey, handle] of this.handles.entries()) {
      if (handle.cwd !== normalizedCwd) {
        continue;
      }
      if (this.terminalSession?.conversationKey === threadKey) {
        this.stopTerminalSession('cleanup-project');
      }
      await this.stopHandleConnection(handle, 'cleanup-project');
      this.deletePendingRequestsForHandle(handle);
      this.handles.delete(threadKey);
      if (this.activeThreadKey === threadKey) {
        this.activeThreadKey = null;
      }
    }
  }

  async cleanupConversation(target: { cwd: string; conversationKey: string; sessionId: string | null }): Promise<void> {
    const normalizedCwd = await this.normalizeProjectCwd(target.cwd);
    for (const [threadKey, handle] of this.handles.entries()) {
      if (handle.cwd !== normalizedCwd) {
        continue;
      }
      if (handle.threadKey !== target.conversationKey && handle.sessionId !== target.sessionId) {
        continue;
      }
      if (this.terminalSession?.conversationKey === threadKey) {
        this.stopTerminalSession('cleanup-conversation');
      }
      await this.stopHandleConnection(handle, 'cleanup-conversation');
      this.deletePendingRequestsForHandle(handle);
      this.handles.delete(threadKey);
      if (this.activeThreadKey === threadKey) {
        this.activeThreadKey = null;
      }
    }
  }

  async setTerminalVisibility(payload: { conversationKey: string | null; sessionId: string | null; visible: boolean }): Promise<void> {
    this.terminalVisibilityTarget = resolveTerminalVisibilityTarget(
      payload,
      (conversationKey) => this.handles.get(conversationKey) ?? null,
      (sessionId) => this.getHandleBySessionId(sessionId)
    );

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

    await this.maybeEnsureVisibleTerminalSession(activeHandle);
  }

  async sendTerminalInput(input: string): Promise<void> {
    if (!input) {
      return;
    }
    if (!this.terminalSession) {
      throw new Error('Claude terminal session is not attached');
    }

    const handle = this.handles.get(this.terminalSession.conversationKey) ?? null;
    if (handle) {
      this.touchHandle(handle);
    }
    this.terminalSession.session.pty.write(input);
  }

  async stopActiveRun(): Promise<void> {
    const handle = this.getActiveHandle();
    if (!handle) {
      return;
    }
    await this.stopHandleConnection(handle, 'stop-active-run');
    if (handle.runtime.status === 'running' || handle.runtime.status === 'starting') {
      handle.runtime.status = 'idle';
      this.emitRuntimeMeta(handle);
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
        lastActivityAt: handle?.lastActivityAt ?? Date.now()
      }
    ];
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

    resizeClaudePtySession(this.terminalSession.session, nextCols, nextRows);
    const patch = this.terminalSession.frameState.resize(nextCols, nextRows);
    if (!patch) {
      return;
    }
    this.callbacks.emitTerminalFramePatch({
      conversationKey: this.terminalSession.conversationKey,
      patch
    });
  }

  async shutdown(): Promise<void> {
    clearInterval(this.gcTimer);
    this.stopTerminalSession('shutdown');
    for (const handle of this.handles.values()) {
      await this.stopHandleConnection(handle, 'shutdown');
    }
    this.handles.clear();
    this.pendingRuntimeRequests.clear();
    this.activeThreadKey = null;
    await this.stopHost();
  }

  private createHandle(selection: ProviderRuntimeSelection): ClaudeWsHandle {
    return {
      threadKey: selection.conversationKey,
      cwd: selection.cwd,
      label: selection.label,
      initialized: false,
      lastActivityAt: Date.now(),
      launchPromise: null,
      runtime: this.createFreshState(selection.conversationKey, selection.sessionId),
      sessionId: selection.sessionId,
      sessionEstablished: selection.sessionId !== null,
      connection: null
    };
  }

  private createFreshState(conversationKey: string | null, sessionId: string | null): AgentRuntimeState {
    return {
      allMessages: [],
      providerId: 'claude',
      conversationKey,
      status: 'idle',
      sessionId,
      messages: [],
      hasOlderMessages: false,
      lastError: null,
      transientNotice: null
    };
  }

  private snapshotForHandle(handle: ClaudeWsHandle, maxMessages?: number): RuntimeSnapshot {
    const normalizedMaxMessages = normalizeMaxMessages(maxMessages, this.options.snapshotMessagesMax);
    const messages = selectRecentMessages(handle.runtime.allMessages, normalizedMaxMessages);
    return cloneValue({
      providerId: 'claude',
      conversationKey: handle.threadKey,
      status: handle.runtime.status,
      sessionId: handle.sessionId,
      messages,
      hasOlderMessages: handle.runtime.allMessages.length > messages.length || handle.runtime.hasOlderMessages,
      lastError: handle.runtime.lastError,
      transientNotice: handle.runtime.transientNotice
    } satisfies RuntimeSnapshot);
  }

  private emitRuntimeMeta(handle: ClaudeWsHandle): void {
    this.callbacks.emitRuntimeMeta({
      providerId: 'claude',
      conversationKey: handle.threadKey,
      cwd: handle.cwd,
      lastError: handle.runtime.lastError,
      sessionId: handle.sessionId,
      status: handle.runtime.status,
      transientNotice: handle.runtime.transientNotice
    } satisfies Omit<RuntimeMetaPayload, 'cliId'>);
  }

  private emitIncrementalMessagesUpsert(
    handle: ClaudeWsHandle,
    previousMessages: ChatMessage[],
    nextMessages: ChatMessage[],
    previousHasOlderMessages: boolean,
    nextHasOlderMessages: boolean
  ): void {
    const previousById = new Map(previousMessages.map((message) => [message.id, message]));
    const upserts = nextMessages.filter((message) => {
      const previous = previousById.get(message.id);
      return !previous || !messagesEqual([previous], [message]);
    });
    const hasChanges = upserts.length > 0 || previousHasOlderMessages !== nextHasOlderMessages;
    if (!hasChanges) {
      return;
    }
    this.callbacks.emitMessagesUpsert({
      providerId: 'claude',
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      upserts: cloneValue(upserts),
      recentMessageIds: nextMessages.map((message) => message.id),
      hasOlderMessages: nextHasOlderMessages
    });
  }

  private emitCurrentMessagesUpsert(handle: ClaudeWsHandle): void {
    if (handle.runtime.messages.length === 0 && !handle.runtime.hasOlderMessages) {
      return;
    }
    this.callbacks.emitMessagesUpsert({
      providerId: 'claude',
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      upserts: cloneValue(handle.runtime.messages),
      recentMessageIds: handle.runtime.messages.map((message) => message.id),
      hasOlderMessages: handle.runtime.hasOlderMessages
    });
  }

  private replaceHandleMessages(handle: ClaudeWsHandle, allMessages: ChatMessage[]): void {
    const previousMessages = handle.runtime.messages;
    const previousHasOlderMessages = handle.runtime.hasOlderMessages;
    const normalizedMaxMessages = Math.max(1, this.options.snapshotMessagesMax);
    const nextMessages = selectRecentMessages(allMessages, normalizedMaxMessages);
    const nextHasOlderMessages = allMessages.length > nextMessages.length;
    const deltaPayloads = createStreamingMessageDeltaPayloads(
      handle,
      previousMessages,
      nextMessages,
      previousHasOlderMessages,
      nextHasOlderMessages
    );

    handle.runtime.allMessages = allMessages;
    handle.runtime.messages = nextMessages;
    handle.runtime.hasOlderMessages = nextHasOlderMessages;
    handle.initialized = handle.initialized || nextMessages.length > 0 || nextHasOlderMessages;

    if (!messagesEqual(previousMessages, nextMessages) || previousHasOlderMessages !== nextHasOlderMessages) {
      if (deltaPayloads && deltaPayloads.length > 0) {
        for (const payload of deltaPayloads) {
          this.callbacks.emitMessageDelta(payload);
        }
        return;
      }
      this.emitIncrementalMessagesUpsert(handle, previousMessages, nextMessages, previousHasOlderMessages, nextHasOlderMessages);
    }
  }

  private mergeHandleMessages(handle: ClaudeWsHandle, upserts: ChatMessage[]): void {
    const mergedMessages = mergeMessages(handle.runtime.allMessages, upserts);
    this.replaceHandleMessages(handle, mergedMessages);
  }

  private touchHandle(handle: ClaudeWsHandle): void {
    handle.lastActivityAt = Date.now();
  }

  private hasPendingRuntimeRequestsForHandle(handle: ClaudeWsHandle): boolean {
    for (const pending of this.pendingRuntimeRequests.values()) {
      if (pending.conversationKey === handle.threadKey) {
        return true;
      }
    }
    return false;
  }

  private isWarmHandle(handle: ClaudeWsHandle): boolean {
    return handle.initialized || handle.connection !== null || handle.runtime.allMessages.length > 0;
  }

  private isProtectedHandle(handle: ClaudeWsHandle): boolean {
    return (
      handle.threadKey === this.activeThreadKey ||
      handle.runtime.status === 'running' ||
      handle.runtime.status === 'starting' ||
      this.hasPendingRuntimeRequestsForHandle(handle)
    );
  }

  private async pruneWarmHandles(reason: 'timer' | 'activate' | 'hydrate' | 'dispatch'): Promise<void> {
    if (this.prunePromise) {
      await this.prunePromise;
      return;
    }

    this.prunePromise = (async () => {
      const now = Date.now();
      const ttlCandidates = [...this.handles.values()]
        .filter((handle) => this.isWarmHandle(handle) && !this.isProtectedHandle(handle))
        .filter((handle) => (handle.lastActivityAt ?? 0) <= now - CLAUDE_WARM_HANDLE_TTL_MS)
        .sort((left, right) => (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0));

      for (const handle of ttlCandidates) {
        await this.disposeHandle(handle, `warm-ttl:${reason}`);
      }

      let warmHandles = [...this.handles.values()]
        .filter((handle) => this.isWarmHandle(handle) && !this.isProtectedHandle(handle))
        .sort((left, right) => (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0));

      while (warmHandles.length > CLAUDE_MAX_WARM_HANDLES) {
        const candidate = warmHandles.shift();
        if (!candidate) {
          break;
        }
        await this.disposeHandle(candidate, `warm-cap:${reason}`);
        warmHandles = [...this.handles.values()]
          .filter((handle) => this.isWarmHandle(handle) && !this.isProtectedHandle(handle))
          .sort((left, right) => (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0));
      }
    })()
      .catch((error) => {
        this.log('warn', 'failed to prune claude warm handles', {
          error: errorMessage(error, 'Failed to prune Claude warm handles')
        });
      })
      .finally(() => {
        this.prunePromise = null;
      });

    await this.prunePromise;
  }

  private async disposeHandle(handle: ClaudeWsHandle, reason: string): Promise<void> {
    if (this.terminalSession?.conversationKey === handle.threadKey) {
      this.stopTerminalSession(`dispose:${reason}`);
    }
    await this.stopHandleConnection(handle, reason);
    this.deletePendingRequestsForHandle(handle);
    this.handles.delete(handle.threadKey);
    if (this.activeThreadKey === handle.threadKey) {
      this.activeThreadKey = null;
    }
    this.log('info', 'disposed claude warm handle', {
      conversationKey: handle.threadKey,
      reason,
      sessionId: handle.sessionId
    });
  }

  private clearLastError(handle: ClaudeWsHandle): void {
    if (handle.runtime.lastError === null && handle.runtime.status !== 'error') {
      return;
    }
    handle.runtime.lastError = null;
    if (handle.runtime.status === 'error') {
      handle.runtime.status = 'idle';
    }
    this.emitRuntimeMeta(handle);
  }

  private nextSequence(messages: ChatMessage[]): number {
    return messages.reduce((max, message) => Math.max(max, message.sequence ?? 0), 0) + 1;
  }

  private getActiveHandle(): ClaudeWsHandle | null {
    if (!this.activeThreadKey) {
      return null;
    }
    return this.handles.get(this.activeThreadKey) ?? null;
  }

  private getHandleBySessionId(sessionId: string): ClaudeWsHandle | null {
    for (const handle of this.handles.values()) {
      if (handle.sessionId === sessionId) {
        return handle;
      }
    }

    return null;
  }

  private async resolveHandleForSelection(selection: ProviderRuntimeSelection): Promise<ClaudeWsHandle> {
    const normalized = await this.normalizeSelection(selection);
    let handle = this.handles.get(normalized.conversationKey);
    if (!handle) {
      handle = this.createHandle(normalized);
      this.handles.set(handle.threadKey, handle);
      return handle;
    }

    handle.cwd = normalized.cwd;
    handle.label = normalized.label;
    const nextSessionId = preferIncomingSessionId(handle.sessionId, normalized.sessionId);
    if (nextSessionId !== handle.sessionId) {
      handle.sessionId = nextSessionId;
      handle.runtime.sessionId = nextSessionId;
      handle.sessionEstablished = nextSessionId !== null;
    }

    return handle;
  }

  private async normalizeSelection(selection: ProviderRuntimeSelection): Promise<ProviderRuntimeSelection> {
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

  private async hydrateHandleFromJsonl(handle: ClaudeWsHandle, maxMessages?: number): Promise<void> {
    if (!handle.sessionId) {
      return;
    }

    const filePath = resolveClaudeJsonlFilePath(handle.cwd, handle.sessionId, os.homedir());
    let rawJsonl = '';
    try {
      rawJsonl = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (!rawJsonl.trim()) {
      return;
    }

    const parsedMessages = parseClaudeJsonlMessages(rawJsonl);
    handle.runtime.status = handle.connection ? handle.runtime.status : 'idle';
    handle.runtime.lastError = null;
    this.replaceHandleMessages(handle, parsedMessages);
  }

  private async ensureHost(): Promise<ClaudeWsHost> {
    if (this.host) {
      return this.host;
    }
    if (!this.hostPromise) {
      this.hostPromise = this.startHost()
        .then((host) => {
          this.host = host;
          return host;
        })
        .finally(() => {
          this.hostPromise = null;
        });
    }
    return await this.hostPromise;
  }

  private async startHost(): Promise<ClaudeWsHost> {
    const sdkPath = '/sdk';
    const server = http.createServer();
    const wsServer = new WebSocketServer({ server, path: sdkPath });
    const host: ClaudeWsHost = {
      pendingConnections: new Map(),
      port: 0,
      sdkPath,
      server,
      wsServer
    };

    wsServer.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
      const requestUrl = request.url ?? '';
      const token = new URL(requestUrl, 'ws://127.0.0.1').searchParams.get('handle');
      const pending = token ? host.pendingConnections.get(token) ?? null : null;
      if (!pending) {
        socket.close();
        return;
      }

      host.pendingConnections.delete(token!);
      clearTimeout(pending.timeout);

      const { connection, handle } = pending;
      if (connection.closed || handle.connection !== connection) {
        socket.close();
        pending.resolve();
        return;
      }

      connection.socket = socket;
      socket.on('message', (raw: RawData) => {
        void this.handleSocketMessage(handle, raw).catch((error) => {
          this.log('error', 'failed to process claude ws message', {
            conversationKey: handle.threadKey,
            error: errorMessage(error, 'Failed to process Claude ws message'),
            sessionId: handle.sessionId
          });
        });
      });
      socket.once('close', () => {
        const currentConnection = handle.connection;
        if (!currentConnection || currentConnection !== connection) {
          return;
        }
        currentConnection.socket = null;
      });

      for (const line of connection.pendingLines.splice(0)) {
        socket.send(line);
      }

      pending.resolve();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      wsServer.close();
      server.close();
      throw new Error('Failed to allocate a local port for Claude ws runtime');
    }
    host.port = address.port;

    server.on('close', () => {
      for (const [token, pending] of host.pendingConnections.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Claude ws host closed before the session connected'));
        host.pendingConnections.delete(token);
      }
    });

    return host;
  }

  private buildClaudeSdkUrl(host: ClaudeWsHost, hostToken: string): string {
    const search = new URLSearchParams({ handle: hostToken }).toString();
    return `ws://127.0.0.1:${host.port}${host.sdkPath}?${search}`;
  }

  private waitForHostConnection(host: ClaudeWsHost, handle: ClaudeWsHandle, connection: ClaudeWsConnection): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        host.pendingConnections.delete(connection.hostToken);
        reject(new Error(`Claude ws runtime did not connect within ${this.options.claudeReadyTimeoutMs}ms`));
      }, Math.max(1_000, this.options.claudeReadyTimeoutMs));

      host.pendingConnections.set(connection.hostToken, {
        connection,
        handle,
        reject,
        resolve,
        timeout
      });
    });
  }

  private rejectPendingHostConnection(hostToken: string, error: Error): void {
    const pending = this.host?.pendingConnections.get(hostToken) ?? null;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.host?.pendingConnections.delete(hostToken);
    pending.reject(error);
  }

  private async stopHost(): Promise<void> {
    const host = this.host ?? await this.hostPromise?.catch(() => null) ?? null;
    this.host = null;
    if (!host) {
      return;
    }

    for (const [token, pending] of host.pendingConnections.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Claude ws host stopped'));
      host.pendingConnections.delete(token);
    }

    await new Promise<void>((resolve) => {
      try {
        host.wsServer.close(() => {
          host.server.close(() => {
            resolve();
          });
        });
      } catch {
        try {
          host.server.close(() => {
            resolve();
          });
        } catch {
          resolve();
        }
      }
    });
  }

  private async ensureHandleConnection(handle: ClaudeWsHandle): Promise<void> {
    if (!handle.sessionId) {
      throw new Error('Claude session id is missing');
    }
    if (handle.connection && !handle.connection.closed && handle.connection.socket) {
      return;
    }
    if (handle.launchPromise) {
      await handle.launchPromise;
      return;
    }

    handle.launchPromise = this.startHandleConnection(handle)
      .finally(() => {
        handle.launchPromise = null;
      });
    await handle.launchPromise;
  }

  private async startHandleConnection(handle: ClaudeWsHandle): Promise<void> {
    const host = await this.ensureHost();
    const hostToken = randomUUID();
    const sdkUrl = this.buildClaudeSdkUrl(host, hostToken);
    const launch = createClaudeShellExecConfig(
      this.buildClaudeLaunchArgs(handle.sessionId!, sdkUrl, handle.sessionEstablished),
      process.env
    );

    const connection: ClaudeWsConnection = {
      activeAssistantStatesByScope: new Map(),
      child: null,
      closed: false,
      hostToken,
      pendingLines: [],
      socket: null,
      socketBuffer: '',
      stopRequested: false
    };
    handle.connection = connection;
    const readyPromise = this.waitForHostConnection(host, handle, connection);

    const child = spawn(launch.command, launch.args, {
      cwd: handle.cwd,
      env: {
        ...process.env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    connection.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.log(this.options.verbose ? 'info' : 'warn', 'claude ws stdout', {
        chunk: chunk.trim(),
        conversationKey: handle.threadKey,
        sessionId: handle.sessionId
      });
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const trimmed = chunk.trim();
      if (!trimmed) {
        return;
      }
      this.maybeCaptureRetryingNotice(handle, trimmed);
      this.log(this.options.verbose ? 'info' : 'warn', 'claude ws stderr', {
        chunk: trimmed,
        conversationKey: handle.threadKey,
        sessionId: handle.sessionId
      });
    });

    child.once('error', (error) => {
      if (!connection.socket) {
        this.rejectPendingHostConnection(connection.hostToken, new Error(errorMessage(error, 'Claude process failed to start')));
      }
      this.handleConnectionExit(handle, connection, errorMessage(error, 'Claude process failed to start'), true);
    });
    child.once('close', (code, signal) => {
      if (!connection.socket) {
        this.rejectPendingHostConnection(
          connection.hostToken,
          new Error(`Claude process exited before ws ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
        );
      }
      this.handleConnectionExit(
        handle,
        connection,
        `Claude process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        !connection.stopRequested
      );
    });

    try {
      await readyPromise;
      await sleep(40);
      handle.initialized = true;
      this.touchHandle(handle);
      handle.sessionEstablished = true;
      handle.runtime.status = 'idle';
      this.emitRuntimeMeta(handle);
      await this.maybeEnsureVisibleTerminalSession(handle);
    } catch (error) {
      await this.stopHandleConnection(handle, 'launch-failed');
      throw error;
    }
  }

  private buildClaudeLaunchArgs(sessionId: string, sdkUrl: string, resumeExistingSession: boolean): string[] {
    const args: string[] = ['--print'];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    args.push(
      '--sdk-url',
      sdkUrl,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-mode',
      this.options.permissionMode
    );
    if (this.options.verbose) {
      args.push('--verbose');
    }
    if (sessionId) {
      args.push(resumeExistingSession ? '--resume' : '--session-id', sessionId);
    }
    return args;
  }

  private async stopHandleConnection(handle: ClaudeWsHandle, reason: string): Promise<void> {
    const connection = handle.connection;
    handle.connection = null;
    if (!connection || connection.closed) {
      return;
    }
    connection.stopRequested = true;
    connection.closed = true;

    try {
      connection.socket?.close();
    } catch {
      // ignore
    }
    this.rejectPendingHostConnection(connection.hostToken, new Error(`Claude ws launch cancelled (${reason})`));

    if (!connection.child || connection.child.exitCode !== null || connection.child.signalCode !== null) {
      this.log('info', 'stopped claude ws connection', {
        conversationKey: handle.threadKey,
        reason,
        sessionId: handle.sessionId
      });
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          connection.child?.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 1_500);

      connection.child?.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        connection.child?.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.log('info', 'stopped claude ws connection', {
      conversationKey: handle.threadKey,
      reason,
      sessionId: handle.sessionId
    });
  }

  private handleConnectionExit(
    handle: ClaudeWsHandle,
    connection: ClaudeWsConnection,
    summary: string,
    treatAsError: boolean
  ): void {
    if (handle.connection !== connection) {
      return;
    }

    connection.closed = true;
    handle.connection = null;
    this.deletePendingRequestsForHandle(handle);

    if (treatAsError && (handle.runtime.status === 'running' || handle.runtime.status === 'starting')) {
      handle.runtime.status = 'error';
      handle.runtime.lastError = summary;
      this.emitRuntimeMeta(handle);
      return;
    }

    if (handle.runtime.status !== 'error') {
      handle.runtime.status = 'idle';
      this.emitRuntimeMeta(handle);
    }
  }

  private async maybeEnsureVisibleTerminalSession(handle: ClaudeWsHandle): Promise<void> {
    if (!this.terminalVisibilityTarget.visible || !handle.sessionEstablished || !handle.sessionId) {
      return;
    }
    if (
      this.terminalVisibilityTarget.conversationKey !== handle.threadKey ||
      this.terminalVisibilityTarget.sessionId !== handle.sessionId
    ) {
      return;
    }

    try {
      await this.ensureTerminalSession(handle);
    } catch (error) {
      this.log('warn', 'failed to attach claude terminal after visibility change', {
        conversationKey: handle.threadKey,
        cwd: handle.cwd,
        error: errorMessage(error, 'Failed to attach Claude terminal'),
        sessionId: handle.sessionId
      });
    }
  }

  private async ensureTerminalSession(handle: ClaudeWsHandle): Promise<void> {
    if (!handle.sessionId || !handle.sessionEstablished) {
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

    const started = startClaudePtySession({
      cols: this.terminalSize.cols,
      cwd: handle.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      },
      permissionMode: this.options.permissionMode,
      resumeSessionId: handle.sessionId,
      rows: this.terminalSize.rows,
      onData: (chunk) => {
        if (!this.terminalSession || this.terminalSession.token !== token) {
          return;
        }
        this.touchHandle(handle);
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
      session: started.session,
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
    stopClaudePtySession(current.session);
    this.callbacks.emitTerminalSessionEvicted({
      conversationKey: current.conversationKey,
      reason,
      sessionId: current.sessionId
    });
  }

  private async handleSocketMessage(handle: ClaudeWsHandle, raw: RawData): Promise<void> {
    const connection = handle.connection;
    if (!connection) {
      return;
    }
    this.touchHandle(handle);

    const parsed = parseNdjsonChunk(raw.toString(), connection.socketBuffer);
    connection.socketBuffer = parsed.rest;
    for (const line of parsed.lines) {
      if (!line.trim()) {
        continue;
      }
      this.log('info', 'claude ws raw message line', {
        conversationKey: handle.threadKey,
        line,
        sessionId: handle.sessionId
      });
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.log('warn', 'failed to parse claude ws line as json', {
          conversationKey: handle.threadKey,
          line,
          sessionId: handle.sessionId
        });
        continue;
      }
      await this.handleIncomingMessage(handle, message);
    }
  }

  private async handleIncomingMessage(handle: ClaudeWsHandle, message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (handle.runtime.transientNotice) {
      this.clearTransientNotice(handle, 'incoming-ws-message');
    }

    const envelope = message as { type?: string };
    this.log('info', 'claude ws message received', {
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      type: envelope.type ?? 'unknown'
    });
    switch (envelope.type) {
      case 'assistant':
        this.handleAssistantMessage(handle, message as ClaudeAssistantEnvelope);
        return;
      case 'stream_event':
        this.handleStreamEvent(handle, message as ClaudeStreamEventEnvelope);
        return;
      case 'control_request':
        this.handleControlRequest(handle, message as ClaudeControlRequestEnvelope);
        return;
      case 'result':
        this.handleResultMessage(handle, message as ClaudeResultEnvelope);
        return;
      case 'system':
        this.handleSystemMessage(handle, message as ClaudeSystemEnvelope);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(handle: ClaudeWsHandle, message: ClaudeStreamEventEnvelope): void {
    const connection = handle.connection;
    if (!connection) {
      return;
    }

    const event = message.event;
    if (!event || typeof event !== 'object') {
      return;
    }

    const scope = streamScopeKey(message.parent_tool_use_id);
    switch (event.type) {
      case 'message_start': {
        const messageId = event.message?.id?.trim();
        if (!messageId) {
          return;
        }
        connection.activeAssistantStatesByScope.set(scope, {
          messageId,
          textBlockIndices: []
        });
        return;
      }
      case 'content_block_delta': {
        if (event.delta?.type !== 'text_delta') {
          return;
        }
        const streamState = connection.activeAssistantStatesByScope.get(scope) ?? null;
        if (!streamState) {
          return;
        }
        const deltaText = event.delta.text ?? '';
        if (!deltaText) {
          return;
        }
        const rawBlockIndex =
          typeof event.index === 'number' && Number.isFinite(event.index) && event.index >= 0
            ? Math.floor(event.index)
            : 0;
        const blockIndex = resolveStreamingTextBlockIndex(streamState, rawBlockIndex);
        this.applyStreamingTextDelta(handle, streamState.messageId, blockIndex, deltaText);
        return;
      }
      case 'message_stop':
        connection.activeAssistantStatesByScope.delete(scope);
        return;
      default:
        return;
    }
  }

  private applyStreamingTextDelta(
    handle: ClaudeWsHandle,
    messageId: string,
    blockIndex: number,
    deltaText: string
  ): void {
    const existingMessage = handle.runtime.allMessages.find((message) => message.id === messageId) ?? null;
    const blockId = `${messageId}:text:${blockIndex}`;
    const nextBlocks = existingMessage?.blocks.slice() ?? [];
    const existingBlockIndex = nextBlocks.findIndex(
      (block) => block.id === blockId && block.type === 'text'
    );

    if (existingBlockIndex >= 0) {
      const existingBlock = nextBlocks[existingBlockIndex];
      if (existingBlock?.type !== 'text') {
        return;
      }
      nextBlocks[existingBlockIndex] = {
        ...existingBlock,
        text:
          deltaText === existingBlock.text
            ? existingBlock.text
            : deltaText.startsWith(existingBlock.text)
              ? deltaText
              : `${existingBlock.text}${deltaText}`
      };
    } else {
      nextBlocks.push({
        id: blockId,
        type: 'text',
        text: deltaText
      });
    }

    this.mergeHandleMessages(handle, [
      {
        id: messageId,
        role: 'assistant',
        blocks: nextBlocks,
        status: 'streaming',
        createdAt: existingMessage?.createdAt ?? new Date().toISOString(),
        sequence: existingMessage?.sequence ?? this.nextSequence(handle.runtime.allMessages)
      }
    ]);
  }

  private handleAssistantMessage(handle: ClaudeWsHandle, message: ClaudeAssistantEnvelope): void {
    const role = message.message?.role;
    if (role !== 'assistant') {
      return;
    }

    const baseId = message.message?.id?.trim() || `claude:assistant:${handle.sessionId ?? handle.threadKey}:${this.nextSequence(handle.runtime.allMessages)}`;
    const blocks = extractContentBlocks(baseId, message.message?.content);
    if (!hasVisibleBlocks(blocks)) {
      return;
    }

    const nextMessage: ChatMessage = {
      id: baseId,
      role: 'assistant',
      blocks,
      status: message.message?.stop_reason ? deriveMessageStatus(blocks, 'complete') : deriveMessageStatus(blocks, 'streaming'),
      createdAt: new Date().toISOString(),
      sequence: this.nextSequence(handle.runtime.allMessages)
    };
    this.mergeHandleMessages(handle, [nextMessage]);
  }

  private handleControlRequest(handle: ClaudeWsHandle, message: ClaudeControlRequestEnvelope): void {
    const requestId = message.request_id ?? null;
    const subtype = message.request?.subtype?.trim() || '';
    if (requestId === null || !subtype) {
      return;
    }
    this.touchHandle(handle);

    this.pendingRuntimeRequests.set(requestId, {
      conversationKey: handle.threadKey,
      params: {
        toolName: message.request?.tool_name ?? null,
        input: message.request?.input ?? null,
        message: message.request?.message ?? null,
        requestedSchema: message.request?.requested_schema ?? null
      },
      requestId,
      sessionId: handle.sessionId,
      subtype
    });

    this.callbacks.emitRuntimeRequest({
      providerId: 'claude',
      conversationKey: handle.threadKey,
      sessionId: handle.sessionId,
      requestId,
      method: claudeRuntimeRequestMethod(subtype),
      params: this.pendingRuntimeRequests.get(requestId)?.params ?? null
    } satisfies Omit<RuntimeRequestPayload, 'cliId'>);
  }

  private handleResultMessage(handle: ClaudeWsHandle, message: ClaudeResultEnvelope): void {
    this.touchHandle(handle);
    const previousStatus = handle.runtime.status;
    const previousLastError = handle.runtime.lastError;
    this.replaceHandleMessages(handle, finalizeStreamingMessages(handle.runtime.allMessages));
    handle.runtime.status = 'idle';
    handle.runtime.lastError = null;
    if (typeof message.result === 'string' && message.result.toLowerCase() === 'error') {
      handle.runtime.status = 'error';
      handle.runtime.lastError = 'Claude returned an error result';
    }
    if (previousStatus !== handle.runtime.status || previousLastError !== handle.runtime.lastError) {
      this.emitRuntimeMeta(handle);
    }
  }

  private handleSystemMessage(handle: ClaudeWsHandle, message: ClaudeSystemEnvelope): void {
    if (message.subtype === 'api_retry') {
      const attempt = typeof message.attempt === 'number' ? message.attempt : null;
      const maxRetries = typeof message.max_retries === 'number' ? message.max_retries : null;
      const retryDelayMs = typeof message.retry_delay_ms === 'number' ? message.retry_delay_ms : null;
      const errorStatus = typeof message.error_status === 'number' ? message.error_status : null;
      const errorCode = typeof message.error === 'string' ? message.error.trim() : '';
      const details = [
        attempt !== null ? `attempt ${attempt}${maxRetries !== null ? `/${maxRetries}` : ''}` : null,
        errorStatus !== null ? `status ${errorStatus}` : null,
        errorCode || null,
        retryDelayMs !== null ? `retry in ${Math.max(1, Math.round(retryDelayMs))}ms` : null
      ]
        .filter(Boolean)
        .join(' · ');

      this.log('warn', 'claude api retry system event', {
        attempt,
        conversationKey: handle.threadKey,
        error: errorCode || null,
        errorStatus,
        maxRetries,
        retryDelayMs,
        sessionId: handle.sessionId
      });
      this.setRetryingNotice(handle, 'Claude API retrying...', details || null);
      return;
    }

    if (message.subtype === 'init' && handle.runtime.status === 'starting') {
      handle.runtime.status = 'idle';
      this.emitRuntimeMeta(handle);
    }
  }

  private queueMessage(handle: ClaudeWsHandle, payload: unknown): void {
    const line = `${JSON.stringify(payload)}\n`;
    const connection = handle.connection;
    if (!connection || connection.closed) {
      throw new Error('Claude ws runtime is not connected');
    }
    if (connection.socket) {
      connection.socket.send(line);
      return;
    }
    connection.pendingLines.push(line);
  }

  private deletePendingRequestsForHandle(handle: ClaudeWsHandle): void {
    for (const [requestId, pending] of this.pendingRuntimeRequests.entries()) {
      if (pending.conversationKey !== handle.threadKey) {
        continue;
      }
      this.pendingRuntimeRequests.delete(requestId);
      this.callbacks.emitRuntimeRequestResolved({
        providerId: 'claude',
        conversationKey: pending.conversationKey,
        sessionId: pending.sessionId,
        requestId
      } satisfies Omit<RuntimeRequestResolvedPayload, 'cliId'>);
    }
  }

  private emitPendingRuntimeRequestsForHandle(handle: ClaudeWsHandle): void {
    for (const pending of this.pendingRuntimeRequests.values()) {
      if (pending.conversationKey !== handle.threadKey) {
        continue;
      }
      this.callbacks.emitRuntimeRequest({
        providerId: 'claude',
        conversationKey: pending.conversationKey,
        sessionId: pending.sessionId,
        requestId: pending.requestId,
        method: claudeRuntimeRequestMethod(pending.subtype),
        params: cloneValue(pending.params)
      } satisfies Omit<RuntimeRequestPayload, 'cliId'>);
    }
  }
}
