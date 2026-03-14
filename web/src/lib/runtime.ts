import type { ChatMessage, RuntimeSnapshot, RuntimeStatus } from '@shared/runtime-types.ts';

export const MOBILE_TERMINAL_BREAKPOINT = 768;
export const MOBILE_TERMINAL_MIN_COLS = 80;

export function createEmptySnapshot(): RuntimeSnapshot {
  return {
    providerId: null,
    conversationKey: null,
    status: 'idle',
    sessionId: null,
    messages: [],
    hasOlderMessages: false,
    lastError: null
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

export function mergeChronologicalMessages(left: ChatMessage[], right: ChatMessage[]): ChatMessage[] {
  const messages = [...left, ...right];
  messages.sort((a, b) => {
    const leftTimestamp = new Date(a.createdAt).getTime();
    const rightTimestamp = new Date(b.createdAt).getTime();
    if (leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }
    return a.id.localeCompare(b.id);
  });

  const uniqueMessages = new Map<string, ChatMessage>();
  for (const message of messages) {
    uniqueMessages.set(message.id, message);
  }

  return [...uniqueMessages.values()].sort((a, b) => {
    const leftTimestamp = new Date(a.createdAt).getTime();
    const rightTimestamp = new Date(b.createdAt).getTime();
    if (leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }
    return a.id.localeCompare(b.id);
  });
}
