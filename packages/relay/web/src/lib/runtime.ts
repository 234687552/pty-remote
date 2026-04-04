import type { ChatMessage, RuntimeSnapshot, RuntimeStatus } from '@lzdi/pty-remote-protocol/runtime-types.ts';

export const MOBILE_TERMINAL_BREAKPOINT = 768;

export function createEmptySnapshot(): RuntimeSnapshot {
  return {
    providerId: null,
    conversationKey: null,
    status: 'idle',
    sessionId: null,
    messages: [],
    hasOlderMessages: false,
    lastError: null,
    transientNotice: null
  };
}

export function isBusyStatus(status: RuntimeStatus): boolean {
  return status === 'starting' || status === 'running';
}

export function getRuntimeStatusLabel(status: RuntimeStatus): string {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

export function isCliOfflineMessage(message: string | null | undefined): boolean {
  return (message ?? '').trim() === 'CLI is offline';
}

export function getSocketBaseUrl(): string {
  const envValue = import.meta.env.VITE_SOCKET_URL;
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  return window.location.origin;
}

export function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function getChronologyTimestamp(message: ChatMessage): number {
  const parsed = new Date(message.createdAt).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getChronologySequence(message: ChatMessage): number {
  return Number.isFinite(message.sequence) ? (message.sequence as number) : Number.MAX_SAFE_INTEGER;
}

export function compareMessageChronology(left: ChatMessage, right: ChatMessage): number {
  const leftTimestamp = getChronologyTimestamp(left);
  const rightTimestamp = getChronologyTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  const leftSequence = getChronologySequence(left);
  const rightSequence = getChronologySequence(right);
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return left.id.localeCompare(right.id);
}

export function sortChronologicalMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice().sort(compareMessageChronology);
}

function createMessageSemanticKey(message: ChatMessage): string {
  const metaSignature = `${message.meta?.turnId ?? ''}:${message.meta?.phase ?? ''}`;
  const blocksSignature = message.blocks
    .map((block) => {
      if (block.type === 'text') {
        return `text:${block.text.trim()}`;
      }
      if (block.type === 'tool_use') {
        return `tool_use:${block.toolCallId ?? ''}:${block.toolName.trim()}:${block.input.trim()}`;
      }
      return `tool_result:${block.toolCallId ?? ''}:${block.isError ? '1' : '0'}:${block.content.trim()}`;
    })
    .join('|');
  return `${message.role}|${message.createdAt}|${message.sequence ?? ''}|${metaSignature}|${blocksSignature}`;
}

export function mergeChronologicalMessages(left: ChatMessage[], right: ChatMessage[]): ChatMessage[] {
  const bySemanticKey = new Map<string, ChatMessage>();

  for (const message of left) {
    bySemanticKey.set(createMessageSemanticKey(message), message);
  }
  for (const message of right) {
    bySemanticKey.set(createMessageSemanticKey(message), message);
  }

  return sortChronologicalMessages([...bySemanticKey.values()]);
}
