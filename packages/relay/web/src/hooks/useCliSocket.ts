import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { io, type Socket } from 'socket.io-client';

import type {
  CliCommandName,
  CliCommandPayloadMap,
  CliCommandResult,
  CliStatusPayload,
  MessagesUpsertPayload,
  RuntimeSubscriptionPayload,
  RuntimeSnapshotPayload,
  TerminalChunkPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { CliDescriptor, ProviderId, RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { getSocketBaseUrl } from '@/lib/runtime.ts';
import { readCachedLastSeq } from '@/lib/messages-cache.ts';

interface UseCliSocketOptions {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  activeConversationKey: string | null;
  activeSessionId: string | null;
  socketRef?: MutableRefObject<Socket | null>;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onSnapshot?: (snapshot: RuntimeSnapshot) => void;
  onMessagesUpsert?: (payload: MessagesUpsertPayload) => void;
  onTerminalChunk?: (payload: TerminalChunkPayload) => void;
}

export interface CliSocketController {
  socketConnected: boolean;
  clis: CliDescriptor[];
  socketRef: RefObject<Socket | null>;
  sendCommand: <TName extends CliCommandName>(
    name: TName,
    payload: CliCommandPayloadMap[TName],
    targetCliId?: string | null,
    targetProviderId?: ProviderId | null
  ) => Promise<CliCommandResult<TName>>;
}

export function useCliSocket({
  activeCliId,
  activeProviderId,
  activeConversationKey,
  activeSessionId,
  socketRef: externalSocketRef,
  onConnect,
  onDisconnect,
  onSnapshot,
  onMessagesUpsert,
  onTerminalChunk
}: UseCliSocketOptions): CliSocketController {
  const [socketConnected, setSocketConnected] = useState(false);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const internalSocketRef = useRef<Socket | null>(null);
  const socketRef = externalSocketRef ?? internalSocketRef;
  const activeCliIdRef = useRef<string | null>(activeCliId);
  const activeProviderIdRef = useRef<ProviderId | null>(activeProviderId);
  const activeConversationKeyRef = useRef<string | null>(activeConversationKey);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onSnapshotRef = useRef(onSnapshot);
  const onMessagesUpsertRef = useRef(onMessagesUpsert);
  const onTerminalChunkRef = useRef(onTerminalChunk);
  const sendCommandRef = useRef<CliSocketController['sendCommand'] | null>(null);

  useEffect(() => {
    activeCliIdRef.current = activeCliId ?? null;
  }, [activeCliId]);

  useEffect(() => {
    activeProviderIdRef.current = activeProviderId ?? null;
  }, [activeProviderId]);

  useEffect(() => {
    activeConversationKeyRef.current = activeConversationKey ?? null;
  }, [activeConversationKey]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId ?? null;
  }, [activeSessionId]);

  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onSnapshotRef.current = onSnapshot;
    onMessagesUpsertRef.current = onMessagesUpsert;
    onTerminalChunkRef.current = onTerminalChunk;
  }, [onConnect, onDisconnect, onMessagesUpsert, onSnapshot, onTerminalChunk]);

  useEffect(() => {
    function emitRuntimeSubscription(socket: Socket | null): void {
      if (!socket?.connected) {
        return;
      }
      const lastSeq = readCachedLastSeq(
        activeProviderIdRef.current,
        activeConversationKeyRef.current,
        activeSessionIdRef.current
      );
      socket.emit('web:runtime-subscribe', {
        targetCliId: activeCliIdRef.current,
        targetProviderId: activeProviderIdRef.current,
        conversationKey: activeConversationKeyRef.current,
        sessionId: activeSessionIdRef.current,
        lastSeq
      } satisfies RuntimeSubscriptionPayload);
    }

    const socket = io(`${getSocketBaseUrl()}/web`, {
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
      emitRuntimeSubscription(socket);
      onConnectRef.current?.();
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
      onDisconnectRef.current?.();
    });

    socket.on('web:init', (payload: WebInitPayload) => {
      setClis(payload.clis);
    });

    socket.on('cli:update', (payload: CliStatusPayload) => {
      setClis(payload.clis);
    });

    socket.on('runtime:snapshot', (payload: RuntimeSnapshotPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      onSnapshotRef.current?.(payload.snapshot);
    });

    socket.on('runtime:messages-upsert', (payload: MessagesUpsertPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      onMessagesUpsertRef.current?.(payload);
    });

    socket.on('terminal:chunk', (payload: TerminalChunkPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      onTerminalChunkRef.current?.(payload);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    socket.emit('web:runtime-subscribe', {
      targetCliId: activeCliId,
      targetProviderId: activeProviderId,
      conversationKey: activeConversationKey,
      sessionId: activeSessionId,
      lastSeq: readCachedLastSeq(activeProviderId, activeConversationKey, activeSessionId)
    } satisfies RuntimeSubscriptionPayload);
  }, [activeCliId, activeProviderId, activeConversationKey, activeSessionId, socketRef]);

  if (!sendCommandRef.current) {
    sendCommandRef.current = async function sendCommand<TName extends CliCommandName>(
      name: TName,
      payload: CliCommandPayloadMap[TName],
      targetCliId = activeCliIdRef.current,
      targetProviderId = activeProviderIdRef.current
    ): Promise<CliCommandResult<TName>> {
      const socket = socketRef.current;
      if (!socket?.connected) {
        throw new Error('Socket is not connected');
      }
      if (!targetCliId) {
        throw new Error('CLI is not selected');
      }

      const result = await new Promise<CliCommandResult<TName>>((resolve) => {
        socket.emit(
          'web:command',
          { targetCliId, targetProviderId, name, payload } satisfies WebCommandEnvelope<TName>,
          (ack?: CliCommandResult<TName>) => {
            resolve(ack ?? { ok: false, error: 'No response from server' });
          }
        );
      });

      if (!result.ok) {
        throw new Error(result.error || 'Request failed');
      }

      return result;
    };
  }

  return {
    socketConnected,
    clis,
    socketRef,
    sendCommand: sendCommandRef.current
  };
}
