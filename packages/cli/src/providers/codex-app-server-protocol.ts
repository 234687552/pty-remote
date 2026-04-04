export type CodexAppServerRequestId = string | number;

export interface CodexAppServerClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface CodexAppServerInitializeParams {
  clientInfo: CodexAppServerClientInfo;
  capabilities: Record<string, unknown> | null;
}

export interface CodexAppServerInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type CodexAppServerThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export type CodexAppServerThreadSortKey = 'created_at' | 'updated_at';

export type CodexAppServerTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type CodexAppServerThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

export type CodexAppServerCommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type CodexAppServerMessagePhase = 'commentary' | 'final_answer';

export type CodexAppServerUserInput =
  | {
      type: 'text';
      text: string;
      text_elements?: unknown[];
    }
  | {
      type: 'image';
      url: string;
    }
  | {
      type: 'localImage';
      path: string;
    }
  | {
      type: 'skill';
      name: string;
      path: string;
    }
  | {
      type: 'mention';
      name: string;
      path: string;
    };

export interface CodexAppServerTurnError {
  message: string;
  codexErrorInfo: unknown | null;
  additionalDetails: string | null;
}

export type CodexAppServerThreadItem =
  | {
      type: 'userMessage';
      id: string;
      content: CodexAppServerUserInput[];
    }
  | {
      type: 'agentMessage';
      id: string;
      text: string;
      phase: CodexAppServerMessagePhase | null;
      memoryCitation?: unknown | null;
    }
  | {
      type: 'plan';
      id: string;
      text: string;
    }
  | {
      type: 'reasoning';
      id: string;
      summary: string[];
      content: string[];
    }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      source?: string;
      status: CodexAppServerCommandExecutionStatus;
      commandActions?: unknown[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: unknown[];
      status: string;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result: unknown | null;
      error: { message?: string | null } | null;
      durationMs: number | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      tool: string;
      arguments: unknown;
      status: string;
      contentItems:
        | Array<{
            type?: string;
            text?: string;
            imageUrl?: string;
          }>
        | null;
      success: boolean | null;
      durationMs: number | null;
    }
  | {
      type: 'webSearch';
      id: string;
      query: string;
      action: unknown | null;
    };

export interface CodexAppServerTurn {
  id: string;
  items: CodexAppServerThreadItem[];
  status: CodexAppServerTurnStatus;
  error: CodexAppServerTurnError | null;
}

export interface CodexAppServerThread {
  id: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: CodexAppServerThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: string | { custom: string } | { subagent: unknown };
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: unknown | null;
  name: string | null;
  turns: CodexAppServerTurn[];
}

export interface CodexAppServerThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: CodexAppServerThreadSortKey | null;
  modelProviders?: string[] | null;
  sourceKinds?: CodexAppServerThreadSourceKind[] | null;
  archived?: boolean | null;
  cwd?: string | null;
  searchTerm?: string | null;
}

export interface CodexAppServerThreadListResponse {
  data: CodexAppServerThread[];
  nextCursor: string | null;
}

export interface CodexAppServerThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface CodexAppServerThreadReadResponse {
  thread: CodexAppServerThread;
}

export interface CodexAppServerThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted' | Record<string, unknown> | null;
  approvalsReviewer?: string | null;
  sandbox?: string | Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  ephemeral?: boolean | null;
  persistExtendedHistory: boolean;
}

export interface CodexAppServerThreadStartResponse {
  thread: CodexAppServerThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandbox: unknown;
  reasoningEffort: string | null;
}

export interface CodexAppServerTurnStartParams {
  threadId: string;
  input: CodexAppServerUserInput[];
  cwd?: string | null;
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted' | Record<string, unknown> | null;
  approvalsReviewer?: string | null;
  sandboxPolicy?: Record<string, unknown> | string | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: unknown | null;
  personality?: string | null;
  outputSchema?: unknown | null;
  collaborationMode?: unknown | null;
}

export interface CodexAppServerTurnStartResponse {
  turn: CodexAppServerTurn;
}

export interface CodexAppServerTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type CodexAppServerTurnInterruptResponse = Record<string, never>;

export interface CodexAppServerRequestEnvelope<TParams = unknown> {
  id: CodexAppServerRequestId;
  method: string;
  params?: TParams;
}

export interface CodexAppServerSuccessResponse<TResult = unknown> {
  id: CodexAppServerRequestId;
  result: TResult;
}

export interface CodexAppServerErrorPayload {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface CodexAppServerErrorResponse {
  id: CodexAppServerRequestId | null;
  error: CodexAppServerErrorPayload;
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerServerRequest {
  id: CodexAppServerRequestId;
  method: string;
  params?: unknown;
}

export type CodexAppServerIncomingMessage =
  | CodexAppServerSuccessResponse
  | CodexAppServerErrorResponse
  | CodexAppServerNotification
  | CodexAppServerServerRequest;

export function codexAppServerErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return fallback;
}

export function isCodexAppServerSuccessResponse(value: unknown): value is CodexAppServerSuccessResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'id' in value && 'result' in value;
}

export function isCodexAppServerErrorResponse(value: unknown): value is CodexAppServerErrorResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'error' in value;
}

export function isCodexAppServerServerRequest(value: unknown): value is CodexAppServerServerRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'id' in value && 'method' in value && !('result' in value) && !('error' in value);
}

export function isCodexAppServerNotification(value: unknown): value is CodexAppServerNotification {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'method' in value && !('id' in value) && !('result' in value) && !('error' in value);
}
