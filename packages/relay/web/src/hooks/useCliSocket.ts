import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { io, type Socket } from 'socket.io-client';

import type {
  CliCommandName,
  CliCommandPayloadMap,
  CliCommandResult,
  CliStatusPayload,
  MessageDeltaPayload,
  MessagesUpsertPayload,
  RuntimeRequestPayload,
  RuntimeRequestResolvedPayload,
  RuntimeRequestResponsePayload,
  RuntimeSubscriptionPayload,
  RuntimeSnapshotPayload,
  TerminalFramePatchPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@lzdi/pty-remote-protocol/protocol.ts';
import type { CliDescriptor, ProviderId, RuntimeSnapshot } from '@lzdi/pty-remote-protocol/runtime-types.ts';

import { getSocketBaseUrl } from '@/lib/runtime.ts';

interface UseCliSocketOptions {
  activeCliId: string | null;
  activeProviderId: ProviderId | null;
  activeConversationKey: string | null;
  activeSessionId: string | null;
  terminalEnabled?: boolean;
  socketRef?: MutableRefObject<Socket | null>;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onMessageDelta?: (payload: MessageDeltaPayload) => void;
  onSnapshot?: (snapshot: RuntimeSnapshot) => void;
  onMessagesUpsert?: (payload: MessagesUpsertPayload) => void;
  onTerminalFramePatch?: (payload: TerminalFramePatchPayload) => void;
  onRuntimeRequest?: (payload: RuntimeRequestPayload) => void;
  onRuntimeRequestResolved?: (payload: RuntimeRequestResolvedPayload) => void;
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
  sendRuntimeRequestResponse: (
    payload: Omit<RuntimeRequestResponsePayload, 'targetCliId'>,
    targetCliId?: string | null
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function useCliSocket({
  activeCliId,
  activeProviderId,
  activeConversationKey,
  activeSessionId,
  terminalEnabled = false,
  socketRef: externalSocketRef,
  onConnect,
  onDisconnect,
  onMessageDelta,
  onSnapshot,
  onMessagesUpsert,
  onTerminalFramePatch,
  onRuntimeRequest,
  onRuntimeRequestResolved
}: UseCliSocketOptions): CliSocketController {
  const [socketConnected, setSocketConnected] = useState(false);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const internalSocketRef = useRef<Socket | null>(null);
  const socketRef = externalSocketRef ?? internalSocketRef;
  const activeCliIdRef = useRef<string | null>(activeCliId);
  const activeProviderIdRef = useRef<ProviderId | null>(activeProviderId);
  const activeConversationKeyRef = useRef<string | null>(activeConversationKey);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const terminalEnabledRef = useRef(Boolean(terminalEnabled));
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onMessageDeltaRef = useRef(onMessageDelta);
  const onSnapshotRef = useRef(onSnapshot);
  const onMessagesUpsertRef = useRef(onMessagesUpsert);
  const onTerminalFramePatchRef = useRef(onTerminalFramePatch);
  const onRuntimeRequestRef = useRef(onRuntimeRequest);
  const onRuntimeRequestResolvedRef = useRef(onRuntimeRequestResolved);
  const sendCommandRef = useRef<CliSocketController['sendCommand'] | null>(null);
  const sendRuntimeRequestResponseRef = useRef<CliSocketController['sendRuntimeRequestResponse'] | null>(null);

  activeCliIdRef.current = activeCliId ?? null;
  activeProviderIdRef.current = activeProviderId ?? null;
  activeConversationKeyRef.current = activeConversationKey ?? null;
  activeSessionIdRef.current = activeSessionId ?? null;
  terminalEnabledRef.current = Boolean(terminalEnabled);
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;
  onMessageDeltaRef.current = onMessageDelta;
  onSnapshotRef.current = onSnapshot;
  onMessagesUpsertRef.current = onMessagesUpsert;
  onTerminalFramePatchRef.current = onTerminalFramePatch;
  onRuntimeRequestRef.current = onRuntimeRequest;
  onRuntimeRequestResolvedRef.current = onRuntimeRequestResolved;

  useEffect(() => {
    function emitRuntimeSubscription(socket: Socket | null): void {
      if (!socket?.connected) {
        return;
      }
      socket.emit('web:runtime-subscribe', {
        targetCliId: activeCliIdRef.current,
        targetProviderId: activeProviderIdRef.current,
        conversationKey: activeConversationKeyRef.current,
        sessionId: activeSessionIdRef.current,
        terminalEnabled: terminalEnabledRef.current
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
      if (activeConversationKeyRef.current && payload.snapshot.conversationKey !== activeConversationKeyRef.current) {
        return;
      }
      onSnapshotRef.current?.(payload.snapshot);
    });

    socket.on('runtime:messages-upsert', (payload: MessagesUpsertPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      if (activeConversationKeyRef.current && payload.conversationKey !== activeConversationKeyRef.current) {
        return;
      }
      onMessagesUpsertRef.current?.(payload);
    });

    socket.on('runtime:message-delta', (payload: MessageDeltaPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      if (activeConversationKeyRef.current && payload.conversationKey !== activeConversationKeyRef.current) {
        return;
      }
      onMessageDeltaRef.current?.(payload);
    });

    socket.on('terminal:frame-patch', (payload: TerminalFramePatchPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      if (activeConversationKeyRef.current && payload.conversationKey !== activeConversationKeyRef.current) {
        return;
      }
      onTerminalFramePatchRef.current?.(payload);
    });

    socket.on('runtime:request', (payload: RuntimeRequestPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      if (activeConversationKeyRef.current && payload.conversationKey !== activeConversationKeyRef.current) {
        return;
      }
      onRuntimeRequestRef.current?.(payload);
    });

    socket.on('runtime:request-resolved', (payload: RuntimeRequestResolvedPayload) => {
      if (payload.cliId !== activeCliIdRef.current || payload.providerId !== activeProviderIdRef.current) {
        return;
      }
      if (activeConversationKeyRef.current && payload.conversationKey !== activeConversationKeyRef.current) {
        return;
      }
      onRuntimeRequestResolvedRef.current?.(payload);
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
      terminalEnabled
    } satisfies RuntimeSubscriptionPayload);
  }, [activeCliId, activeProviderId, activeConversationKey, activeSessionId, socketRef, terminalEnabled]);

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

  if (!sendRuntimeRequestResponseRef.current) {
    sendRuntimeRequestResponseRef.current = async function sendRuntimeRequestResponse(
      payload: Omit<RuntimeRequestResponsePayload, 'targetCliId'>,
      targetCliId = activeCliIdRef.current
    ): Promise<{ ok: boolean; error?: string }> {
      const socket = socketRef.current;
      if (!socket?.connected) {
        throw new Error('Socket is not connected');
      }
      if (!targetCliId) {
        throw new Error('CLI is not selected');
      }

      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit(
          'web:runtime-request-response',
          {
            targetCliId,
            ...payload
          } satisfies RuntimeRequestResponsePayload,
          (ack?: { ok: boolean; error?: string }) => {
            resolve(ack ?? { ok: false, error: 'No response from runtime request relay' });
          }
        );
      });
    };
  }

  return {
    socketConnected,
    clis,
    socketRef,
    sendCommand: sendCommandRef.current,
    sendRuntimeRequestResponse: sendRuntimeRequestResponseRef.current
  };
}
