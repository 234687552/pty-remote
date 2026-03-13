import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import type {
  CliCommandName,
  CliCommandPayloadMap,
  CliCommandResult,
  CliStatusPayload,
  MessagesUpsertPayload,
  RuntimeSnapshotPayload,
  TerminalChunkPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@shared/protocol.ts';
import type { CliDescriptor, RuntimeSnapshot } from '@shared/runtime-types.ts';

import { getSocketBaseUrl } from '@/lib/runtime.ts';

interface UseCliSocketOptions {
  activeCliId: string | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onSnapshot?: (snapshot: RuntimeSnapshot) => void;
  onMessagesUpsert?: (payload: MessagesUpsertPayload) => void;
  onTerminalChunk?: (payload: TerminalChunkPayload) => void;
}

export interface CliSocketController {
  socketConnected: boolean;
  clis: CliDescriptor[];
  socketRef: React.RefObject<Socket | null>;
  sendCommand: <TName extends CliCommandName>(
    name: TName,
    payload: CliCommandPayloadMap[TName],
    targetCliId?: string | null
  ) => Promise<CliCommandResult<TName>>;
}

export function useCliSocket({
  activeCliId,
  onConnect,
  onDisconnect,
  onSnapshot,
  onMessagesUpsert,
  onTerminalChunk
}: UseCliSocketOptions): CliSocketController {
  const [socketConnected, setSocketConnected] = useState(false);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const activeCliIdRef = useRef<string | null>(activeCliId);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onSnapshotRef = useRef(onSnapshot);
  const onMessagesUpsertRef = useRef(onMessagesUpsert);
  const onTerminalChunkRef = useRef(onTerminalChunk);

  useEffect(() => {
    activeCliIdRef.current = activeCliId ?? null;
  }, [activeCliId]);

  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onSnapshotRef.current = onSnapshot;
    onMessagesUpsertRef.current = onMessagesUpsert;
    onTerminalChunkRef.current = onTerminalChunk;
  }, [onConnect, onDisconnect, onMessagesUpsert, onSnapshot, onTerminalChunk]);

  useEffect(() => {
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
      if (payload.cliId !== activeCliIdRef.current) {
        return;
      }
      onSnapshotRef.current?.(payload.snapshot);
    });

    socket.on('runtime:messages-upsert', (payload: MessagesUpsertPayload) => {
      if (payload.cliId !== activeCliIdRef.current) {
        return;
      }
      onMessagesUpsertRef.current?.(payload);
    });

    socket.on('terminal:chunk', (payload: TerminalChunkPayload) => {
      if (payload.cliId !== activeCliIdRef.current) {
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

  async function sendCommand<TName extends CliCommandName>(
    name: TName,
    payload: CliCommandPayloadMap[TName],
    targetCliId = activeCliIdRef.current
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
        { targetCliId, name, payload } satisfies WebCommandEnvelope<TName>,
        (ack?: CliCommandResult<TName>) => {
          resolve(ack ?? { ok: false, error: 'No response from server' });
        }
      );
    });

    if (!result.ok) {
      throw new Error(result.error || 'Request failed');
    }

    return result;
  }

  return {
    socketConnected,
    clis,
    socketRef,
    sendCommand
  };
}
