import {
  codexAppServerErrorMessage,
  isCodexAppServerErrorResponse,
  isCodexAppServerNotification,
  isCodexAppServerServerRequest,
  isCodexAppServerSuccessResponse,
  type CodexAppServerErrorResponse,
  type CodexAppServerInitializeParams,
  type CodexAppServerInitializeResponse,
  type CodexAppServerNotification,
  type CodexAppServerRequestEnvelope,
  type CodexAppServerRequestId,
  type CodexAppServerServerRequest
} from './codex-app-server-protocol.ts';
import { CodexAppServerProcess, type CodexAppServerEndpoint, type CodexAppServerProcessOptions } from './codex-app-server-process.ts';

export interface CodexAppServerClientOptions extends CodexAppServerProcessOptions {
  clientInfo: CodexAppServerInitializeParams['clientInfo'];
  onNotification?: (notification: CodexAppServerNotification) => void;
  onServerRequest?: (request: CodexAppServerServerRequest) => void;
}

interface PendingRequest<TResult> {
  method: string;
  reject: (reason?: unknown) => void;
  resolve: (value: TResult | PromiseLike<TResult>) => void;
}

function parseIncomingMessage(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function responseErrorMessage(error: CodexAppServerErrorResponse, method: string): string {
  return codexAppServerErrorMessage(error.error, `Codex app-server request failed: ${method}`);
}

export class CodexAppServerClient {
  private readonly process: CodexAppServerProcess;

  private readonly options: CodexAppServerClientOptions;

  private connectPromise: Promise<void> | null = null;

  private endpoint: CodexAppServerEndpoint | null = null;

  private initialized = false;

  private readonly pendingRequests = new Map<CodexAppServerRequestId, PendingRequest<unknown>>();

  private requestSequence = 0;

  private socket: WebSocket | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.process = new CodexAppServerProcess(options);
  }

  async ensureConnected(): Promise<void> {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.endpoint = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    this.rejectPendingRequests(new Error('Codex app-server client closed'));
    await this.process.stop();
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not open');
    }

    const id = ++this.requestSequence;
    const payload: CodexAppServerRequestEnvelope = {
      id,
      method,
      params
    };

    return await new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        method,
        resolve: (value) => {
          resolve(value as TResult);
        },
        reject
      });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async getWsUrl(): Promise<string> {
    await this.ensureConnected();
    if (!this.endpoint?.wsUrl) {
      throw new Error('Codex app-server endpoint is not available');
    }
    return this.endpoint.wsUrl;
  }

  async respondToServerRequest(requestId: CodexAppServerRequestId, result?: unknown, error?: string | null): Promise<void> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not open');
    }

    const payload =
      error && error.trim()
        ? {
            id: requestId,
            error: {
              message: error.trim()
            }
          }
        : {
            id: requestId,
            result: result ?? {}
          };
    socket.send(JSON.stringify(payload));
  }

  private async connect(): Promise<void> {
    const endpoint = await this.process.ensureStarted();
    this.endpoint = endpoint;
    const socket = new WebSocket(endpoint.wsUrl);

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (event: Event) => {
        cleanup();
        reject(new Error(`Failed to connect to Codex app-server websocket: ${event.type}`));
      };
      const handleClose = () => {
        cleanup();
        reject(new Error('Codex app-server websocket closed during connection'));
      };
      const cleanup = () => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleError);
        socket.removeEventListener('close', handleClose);
      };

      socket.addEventListener('open', handleOpen);
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleClose);
    });

    socket.addEventListener('message', (event) => {
      void this.handleSocketMessage(event);
    });
    socket.addEventListener('close', () => {
      this.initialized = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      this.rejectPendingRequests(new Error('Codex app-server websocket closed'));
    });
    socket.addEventListener('error', () => {
      this.options.onLog?.('warn', 'codex app-server websocket reported an error');
    });

    this.socket = socket;
    const initializeResult = await this.rawRequest<CodexAppServerInitializeResponse>('initialize', {
      clientInfo: this.options.clientInfo,
      capabilities: null
    });
    this.initialized = true;
    this.sendNotification('initialized');
    this.options.onLog?.('info', 'connected to codex app-server websocket', {
      codexHome: initializeResult.codexHome,
      platformFamily: initializeResult.platformFamily,
      platformOs: initializeResult.platformOs
    });
  }

  private async rawRequest<TResult>(method: string, params?: unknown): Promise<TResult> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not open');
    }

    const id = ++this.requestSequence;
    const payload: CodexAppServerRequestEnvelope = {
      id,
      method,
      params
    };

    return await new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        method,
        resolve: (value) => {
          resolve(value as TResult);
        },
        reject
      });
      socket.send(JSON.stringify(payload));
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = params === undefined ? { method } : { method, params };
    socket.send(JSON.stringify(payload));
  }

  private async handleSocketMessage(event: MessageEvent): Promise<void> {
    const raw =
      typeof event.data === 'string'
        ? event.data
        : event.data instanceof ArrayBuffer
          ? Buffer.from(event.data).toString('utf8')
          : `${event.data}`;
    const message = parseIncomingMessage(raw);
    if (!message) {
      return;
    }

    if (isCodexAppServerSuccessResponse(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (isCodexAppServerErrorResponse(message)) {
      const pending = this.pendingRequests.get(message.id ?? '');
      if (!pending) {
        this.options.onLog?.('error', 'codex app-server returned an unsolicited error response', {
          error: responseErrorMessage(message, 'unknown')
        });
        return;
      }
      this.pendingRequests.delete(message.id ?? '');
      pending.reject(new Error(responseErrorMessage(message, pending.method)));
      return;
    }

    if (isCodexAppServerServerRequest(message)) {
      if (this.options.onServerRequest) {
        this.options.onServerRequest(message);
        return;
      }
      this.sendUnsupportedServerRequestResponse(message);
      return;
    }

    if (isCodexAppServerNotification(message)) {
      this.options.onNotification?.(message);
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }

  private sendUnsupportedServerRequestResponse(request: CodexAppServerServerRequest): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        id: request.id,
        error: {
          message: `Unsupported app-server server request: ${request.method}`
        }
      })
    );
  }
}
