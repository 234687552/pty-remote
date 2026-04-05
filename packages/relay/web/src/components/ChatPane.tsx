import { Children, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Mermaid as MermaidApi } from 'mermaid';
import type { PanZoom as PanZoomInstance } from 'panzoom';
import type { TerminalFrameLine, TerminalFrameSnapshot } from '@lzdi/pty-remote-protocol/terminal-frame.ts';
import type { RuntimeRequestPayload } from '@lzdi/pty-remote-protocol/protocol.ts';

import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageBlock,
  MessageStatus,
  ProviderId,
  RuntimeTransientNotice,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '@lzdi/pty-remote-protocol/runtime-types.ts';
import type { MobileJumpControls } from '@/features/workspace/types.ts';

interface MarkdownNode {
  children?: MarkdownNode[];
  properties?: {
    className?: unknown;
  };
  tagName?: string;
  value?: string;
}

interface SvgDimensions {
  width: number;
  height: number;
}

interface MermaidRenderSnapshot {
  bindFunctions: ((element: Element) => void) | null;
  error: string;
  svg: string;
  svgDimensions: SvgDimensions | null;
}

type MarkdownRenderSegment =
  | {
      content: string;
      key: string;
      type: 'text';
    }
  | {
      definition: string;
      key: string;
      type: 'mermaid';
    };

interface ToolCallMeta {
  resultBlock?: ToolResultChatMessageBlock;
  resultStatus?: MessageStatus;
  toolName?: string;
  useBlockId?: string;
}

interface ApprovalOption {
  id: string;
  input: string;
  label: string;
  shortcut: string;
}

interface TerminalInterruptedState {
  confidence: 'high' | 'medium';
  message: string;
  relatedToolCallId: string | null;
}

interface TerminalApprovalState {
  confidence: 'high' | 'medium';
  contextLines: string[];
  options: ApprovalOption[];
  relatedToolCallId: string | null;
  title: string;
}

interface TerminalSideChannelState {
  approval: TerminalApprovalState | null;
  interrupted: TerminalInterruptedState | null;
}

interface ToolCallUiState {
  hasResult: boolean;
  interrupted: TerminalInterruptedState | null;
  terminalApproval: TerminalApprovalState | null;
}

interface MergedChatToolState {
  approvalNotice: TerminalApprovalState | null;
  interruptedNotice: TerminalInterruptedState | null;
  toolCallUiStateIndex: Map<string, ToolCallUiState>;
}

interface ActivityGroup {
  anchorMessage?: ChatMessage;
  createdAt: string;
  entries: ChatMessage[];
  id: string;
  status: MessageStatus;
  title: string;
  turnId: string;
}

type ChatPaneDisplayItem =
  | {
      type: 'activity_group';
      group: ActivityGroup;
    }
  | {
      type: 'message';
      message: ChatMessage;
    };

interface ChatPaneProps {
  activeProviderId: ProviderId | null;
  canSendApprovalInput?: boolean;
  conversationScrollKey: string | null;
  connected: boolean;
  frameSnapshot?: TerminalFrameSnapshot | null;
  messages: ChatMessage[];
  onMobileJumpControlsChange?: (controls: MobileJumpControls | null) => void;
  onApprovalInput?: (input: string) => void;
  onRespondRuntimeRequest?: (payload: { error?: string | null; requestId: string | number; result?: unknown }) => Promise<void> | void;
  paneVisible: boolean;
  runtimeRequests?: RuntimeRequestPayload[];
  scrollToBottomRequestKey: number;
  transientNotice?: RuntimeTransientNotice | null;
  visible: boolean;
}

const QUESTION_JUMP_LONG_PRESS_DELAY_MS = 420;
const SCROLL_BOTTOM_THRESHOLD_PX = 12;
const TOUCH_SCROLL_INTENT_DELTA_PX = 6;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;
const KNOWN_TERMINAL_APPROVAL_OPTION_LABELS = ['allow', 'allow for this session', 'always allow', 'cancel'] as const;

const EMPTY_MERMAID_RENDER_SNAPSHOT: MermaidRenderSnapshot = {
  bindFunctions: null,
  error: '',
  svg: '',
  svgDimensions: null
};

let mermaidRenderSequence = 0;
let mermaidLoader: Promise<MermaidApi> | null = null;
const mermaidRenderCache = new Map<string, MermaidRenderSnapshot & { promise: Promise<MermaidRenderSnapshot> | null }>();
let panzoomLoader: Promise<typeof import('panzoom').default> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid')
      .then(({ default: mermaidApi }) => {
        mermaidApi.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'neutral',
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        });
        return mermaidApi;
      })
      .catch((error) => {
        mermaidLoader = null;
        throw error;
      });
  }

  return mermaidLoader;
}

function loadPanzoom(): Promise<typeof import('panzoom').default> {
  if (!panzoomLoader) {
    panzoomLoader = import('panzoom')
      .then(({ default: createPanzoom }) => createPanzoom)
      .catch((error) => {
        panzoomLoader = null;
        throw error;
      });
  }

  return panzoomLoader;
}

function getCachedMermaidRenderSnapshot(definition: string): MermaidRenderSnapshot | null {
  const cached = mermaidRenderCache.get(definition);
  if (!cached || (!cached.svg && !cached.error)) {
    return null;
  }

  return {
    bindFunctions: cached.bindFunctions,
    error: cached.error,
    svg: cached.svg,
    svgDimensions: cached.svgDimensions
  };
}

function setCachedMermaidRenderSnapshot(
  definition: string,
  snapshot: MermaidRenderSnapshot,
  promise: Promise<MermaidRenderSnapshot> | null
): void {
  mermaidRenderCache.set(definition, {
    ...snapshot,
    promise
  });
}

function stringifyRuntimeRequestValue(value: unknown): string {
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

function runtimeDecisionLabel(decision: unknown): string {
  if (decision === 'accept') {
    return 'Allow';
  }
  if (decision === 'acceptForSession') {
    return 'Allow This Session';
  }
  if (decision === 'decline') {
    return 'Decline';
  }
  if (decision === 'cancel') {
    return 'Cancel';
  }
  if (decision && typeof decision === 'object') {
    if ('acceptWithExecpolicyAmendment' in decision) {
      return 'Allow and Remember Rule';
    }
    if ('applyNetworkPolicyAmendment' in decision) {
      return 'Apply Network Rule';
    }
  }
  return 'Confirm';
}

function buildRuntimeRequestContext(request: RuntimeRequestPayload): string[] {
  const params = (request.params ?? null) as Record<string, unknown> | null;
  if (!params) {
    return [];
  }

  switch (request.method) {
    case 'item/commandExecution/requestApproval': {
      const lines = [
        typeof params.reason === 'string' ? params.reason.trim() : '',
        typeof params.command === 'string' ? `$ ${params.command}` : '',
        typeof params.cwd === 'string' ? `cwd: ${params.cwd}` : ''
      ].filter(Boolean);
      return lines;
    }
    case 'item/fileChange/requestApproval':
      return [typeof params.reason === 'string' ? params.reason.trim() : '', typeof params.grantRoot === 'string' ? `root: ${params.grantRoot}` : ''].filter(Boolean);
    case 'item/permissions/requestApproval':
      return [
        typeof params.reason === 'string' ? params.reason.trim() : '',
        stringifyRuntimeRequestValue(params.permissions)
      ].filter(Boolean);
    case 'item/tool/requestApproval':
      return [
        typeof params.toolName === 'string' ? `tool: ${params.toolName}` : '',
        stringifyRuntimeRequestValue(params.input)
      ].filter(Boolean);
    case 'item/tool/requestUserInput':
      return [];
    case 'item/tool/requestStructuredInput':
      return [typeof params.message === 'string' ? params.message.trim() : '', stringifyRuntimeRequestValue(params.requestedSchema)].filter(Boolean);
    default:
      return [stringifyRuntimeRequestValue(params)].filter(Boolean);
  }
}

function buildGrantedPermissions(permissions: unknown): Record<string, unknown> {
  if (!permissions || typeof permissions !== 'object') {
    return {};
  }
  const normalized = permissions as { network?: unknown; fileSystem?: unknown };
  const result: Record<string, unknown> = {};
  if (normalized.network !== null && normalized.network !== undefined) {
    result.network = normalized.network;
  }
  if (normalized.fileSystem !== null && normalized.fileSystem !== undefined) {
    result.fileSystem = normalized.fileSystem;
  }
  return result;
}

function RuntimeRequestNotice({
  canRespond,
  onRespond,
  request
}: {
  canRespond: boolean;
  onRespond?: (payload: { error?: string | null; requestId: string | number; result?: unknown }) => Promise<void> | void;
  request: RuntimeRequestPayload;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [toolAnswers, setToolAnswers] = useState<Record<string, string[]>>({});
  const params = (request.params ?? null) as Record<string, unknown> | null;
  const contextLines = buildRuntimeRequestContext(request);

  async function submit(payload: { error?: string | null; result?: unknown }): Promise<void> {
    if (!onRespond || !canRespond) {
      return;
    }
    setSubmitting(true);
    setErrorText('');
    try {
      await onRespond({
        requestId: request.requestId,
        ...payload
      });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to respond');
    } finally {
      setSubmitting(false);
    }
  }

  function renderCommandApproval(): React.ReactNode {
    const availableDecisions = Array.isArray(params?.availableDecisions) && params?.availableDecisions.length > 0
      ? params.availableDecisions
      : ['accept', 'acceptForSession', 'decline', 'cancel'];

    return (
      <div className="space-y-2">
        {availableDecisions.map((decision, index) => (
          <button
            key={`${request.requestId}:${index}`}
            type="button"
            disabled={!canRespond || submitting}
            onClick={() => {
              void submit({ result: { decision } });
            }}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-amber-300 hover:bg-amber-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            {runtimeDecisionLabel(decision)}
          </button>
        ))}
      </div>
    );
  }

  function renderFileChangeApproval(): React.ReactNode {
    const decisions = ['accept', 'acceptForSession', 'decline', 'cancel'];
    return (
      <div className="space-y-2">
        {decisions.map((decision) => (
          <button
            key={`${request.requestId}:${decision}`}
            type="button"
            disabled={!canRespond || submitting}
            onClick={() => {
              void submit({ result: { decision } });
            }}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-amber-300 hover:bg-amber-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            {runtimeDecisionLabel(decision)}
          </button>
        ))}
      </div>
    );
  }

  function renderPermissionsApproval(): React.ReactNode {
    return (
      <div className="space-y-2">
        {(['turn', 'session'] as const).map((scope) => (
          <button
            key={`${request.requestId}:${scope}`}
            type="button"
            disabled={!canRespond || submitting}
            onClick={() => {
              void submit({
                result: {
                  permissions: buildGrantedPermissions(params?.permissions),
                  scope
                }
              });
            }}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-amber-300 hover:bg-amber-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            {scope === 'turn' ? 'Grant For This Turn' : 'Grant For This Session'}
          </button>
        ))}
        <button
          type="button"
          disabled={!canRespond || submitting}
          onClick={() => {
            void submit({ error: 'declined' });
          }}
          className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          Decline
        </button>
      </div>
    );
  }

  function renderToolRequestUserInput(): React.ReactNode {
    const questions = Array.isArray(params?.questions) ? (params.questions as Array<Record<string, unknown>>) : [];
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const answers = Object.fromEntries(
            questions
              .map((question) => {
                const questionId = typeof question.id === 'string' ? question.id : '';
                if (!questionId) {
                  return null;
                }
                const selectedAnswers = toolAnswers[questionId] ?? [];
                return [
                  questionId,
                  {
                    answers: selectedAnswers
                  }
                ];
              })
              .filter(Boolean) as Array<[string, { answers: string[] }]>
          );
          void submit({
            result: {
              answers
            }
          });
        }}
      >
        {questions.map((question, questionIndex) => {
          const questionId = typeof question.id === 'string' ? question.id : `q-${questionIndex}`;
          const header = typeof question.header === 'string' ? question.header : 'Question';
          const prompt = typeof question.question === 'string' ? question.question : '';
          const isOther = question.isOther === true;
          const options = Array.isArray(question.options) ? (question.options as Array<Record<string, unknown>>) : [];
          const selected = toolAnswers[questionId] ?? [];

          return (
            <div key={questionId} className="space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{header}</div>
              <div className="text-sm font-medium text-zinc-900">{prompt}</div>
              {options.length > 0 ? (
                <div className="space-y-2">
                  {options.map((option, optionIndex) => {
                    const label = typeof option.label === 'string' ? option.label : `Option ${optionIndex + 1}`;
                    const checked = selected.includes(label);
                    return (
                      <label key={`${questionId}:${label}`} className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setToolAnswers((current) => {
                              const existing = current[questionId] ?? [];
                              const nextAnswers = event.target.checked
                                ? [...existing, label]
                                : existing.filter((entry) => entry !== label);
                              return {
                                ...current,
                                [questionId]: nextAnswers
                              };
                            });
                          }}
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-900">{label}</div>
                          {typeof option.description === 'string' && option.description.trim() ? (
                            <div className="mt-0.5 text-xs text-zinc-500">{option.description}</div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {isOther || options.length === 0 ? (
                <textarea
                  value={selected.join('\n')}
                  onChange={(event) => {
                    setToolAnswers((current) => ({
                      ...current,
                      [questionId]: event.target.value
                        .split('\n')
                        .map((entry) => entry.trim())
                        .filter(Boolean)
                    }));
                  }}
                  rows={3}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none transition focus:border-zinc-400"
                  placeholder="Enter your answer"
                />
              ) : null}
            </div>
          );
        })}
        <button
          type="submit"
          disabled={!canRespond || submitting}
          className="w-full rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-3 text-left text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          Submit Answers
        </button>
      </form>
    );
  }

  function renderClaudeToolApproval(): React.ReactNode {
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled={!canRespond || submitting}
          onClick={() => {
            void submit({ result: { behavior: 'allow' } });
          }}
          className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          Allow
        </button>
        <button
          type="button"
          disabled={!canRespond || submitting}
          onClick={() => {
            void submit({ result: { behavior: 'deny', message: 'Denied by operator' } });
          }}
          className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          Deny
        </button>
      </div>
    );
  }

  function renderClaudeElicitation(): React.ReactNode {
    const value = toolAnswers.__claude_json__?.join('\n') ?? '';
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) {
            void submit({ result: { action: 'cancel' } });
            return;
          }
          try {
            void submit({
              result: {
                action: 'submit',
                content: JSON.parse(value)
              }
            });
          } catch (error) {
            setErrorText(error instanceof Error ? error.message : 'Invalid JSON');
          }
        }}
      >
        <textarea
          value={value}
          onChange={(event) => {
            setToolAnswers((current) => ({
              ...current,
              __claude_json__: [event.target.value]
            }));
          }}
          rows={6}
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none transition focus:border-zinc-400"
          placeholder="Enter JSON response, or leave empty to cancel"
        />
        <button
          type="submit"
          disabled={!canRespond || submitting}
          className="w-full rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-3 text-left text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          Submit JSON
        </button>
        <button
          type="button"
          disabled={!canRespond || submitting}
          onClick={() => {
            void submit({ result: { action: 'cancel' } });
          }}
          className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        >
          Cancel
        </button>
      </form>
    );
  }

  function renderActions(): React.ReactNode {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return renderCommandApproval();
      case 'item/fileChange/requestApproval':
        return renderFileChangeApproval();
      case 'item/permissions/requestApproval':
        return renderPermissionsApproval();
      case 'item/tool/requestApproval':
        return renderClaudeToolApproval();
      case 'item/tool/requestUserInput':
        return renderToolRequestUserInput();
      case 'item/tool/requestStructuredInput':
        return renderClaudeElicitation();
      default:
        return (
          <button
            type="button"
            disabled={!canRespond || submitting}
            onClick={() => {
              void submit({ error: `unsupported request method: ${request.method}` });
            }}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-left text-sm font-medium text-zinc-900 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            Dismiss Unsupported Request
          </button>
        );
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/85 shadow-sm">
      <div className="border-b border-emerald-200/80 px-4 py-3">
        <div className="text-sm font-semibold text-zinc-950">Pending runtime request</div>
        <div className="mt-1 text-xs leading-5 text-zinc-600">{request.method}</div>
      </div>
      <div className="space-y-3 px-4 py-4">
        {contextLines.length > 0 ? (
          <pre className="overflow-auto rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-5 whitespace-pre-wrap break-all text-zinc-700">
            {contextLines.join('\n')}
          </pre>
        ) : null}
        {renderActions()}
        {errorText ? <div className="text-xs text-red-600">{errorText}</div> : null}
      </div>
    </section>
  );
}

function RuntimeTransientNoticeBanner({ notice }: { notice: RuntimeTransientNotice }) {
  const toneClass =
    notice.kind === 'error'
      ? 'border-red-200/80 bg-red-50/80'
      : notice.kind === 'warning'
        ? 'border-amber-200/80 bg-amber-50/80'
        : 'border-sky-200/80 bg-sky-50/80';

  return (
    <div className="flex justify-start">
      <section className="w-full max-w-[44rem]">
        <div className={`w-fit max-w-full rounded-2xl border px-3 py-2 shadow-sm ${toneClass}`}>
          <div className="flex items-center gap-2 text-[12px] leading-5 text-zinc-900">
            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-current/70 text-amber-700" />
            <span className="min-w-0 truncate font-medium">{notice.message}</span>
          </div>
          {notice.details?.trim() ? (
            <pre className="mt-1.5 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-zinc-600">
              {notice.details.trim()}
            </pre>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function normalizeClassName(className: unknown): string {
  if (typeof className === 'string') {
    return className;
  }

  if (!Array.isArray(className)) {
    return '';
  }

  return className.filter((name): name is string => typeof name === 'string').join(' ');
}

function getMarkdownCodeLanguage(className: string | undefined): string | null {
  const match = className?.match(/language-([\w-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function getMarkdownTextContent(children: React.ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsMermaidFence(markdown: string): boolean {
  return /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t].*)?$/im.test(markdown);
}

function getMarkdownLineRanges(markdown: string): Array<{ content: string; end: number; start: number }> {
  const ranges: Array<{ content: string; end: number; start: number }> = [];
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const lineBreakIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = lineBreakIndex === -1 ? markdown.length : lineBreakIndex + 1;
    const line = markdown.slice(lineStart, lineEnd);
    ranges.push({
      content: line.replace(/\r?\n$/, ''),
      end: lineEnd,
      start: lineStart
    });
    lineStart = lineEnd;
  }

  return ranges;
}

function getMarkdownRenderSegments(markdown: string): MarkdownRenderSegment[] {
  if (!markdown) {
    return [];
  }

  const lineRanges = getMarkdownLineRanges(markdown);
  const segments: MarkdownRenderSegment[] = [];
  let cursor = 0;

  for (let index = 0; index < lineRanges.length; index += 1) {
    const openingMatch = lineRanges[index]?.content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t].*)?$/i);
    if (!openingMatch) {
      continue;
    }

    const openingFence = openingMatch[1];
    const closingFencePattern = new RegExp(`^ {0,3}${escapeRegExp(openingFence[0])}{${openingFence.length},}[ \\t]*$`);
    let closingIndex = -1;

    for (let cursorIndex = index + 1; cursorIndex < lineRanges.length; cursorIndex += 1) {
      if (closingFencePattern.test(lineRanges[cursorIndex]?.content ?? '')) {
        closingIndex = cursorIndex;
        break;
      }
    }

    if (closingIndex === -1) {
      break;
    }

    const openingLine = lineRanges[index];
    const closingLine = lineRanges[closingIndex];
    if (cursor < openingLine.start) {
      segments.push({
        content: markdown.slice(cursor, openingLine.start),
        key: `text:${cursor}`,
        type: 'text'
      });
    }

    segments.push({
      definition: markdown.slice(openingLine.end, closingLine.start).trimEnd(),
      key: `mermaid:${openingLine.start}`,
      type: 'mermaid'
    });

    cursor = closingLine.end;
    index = closingIndex;
  }

  if (cursor < markdown.length) {
    segments.push({
      content: markdown.slice(cursor),
      key: `text:${cursor}`,
      type: 'text'
    });
  }

  return segments;
}

function getSvgDimensions(svg: string): SvgDimensions | null {
  const documentParser = new DOMParser();
  const svgDocument = documentParser.parseFromString(svg, 'image/svg+xml');
  const svgElement = svgDocument.documentElement;
  if (svgElement.tagName.toLowerCase() !== 'svg') {
    return null;
  }

  const viewBox = svgElement.getAttribute('viewBox');
  if (viewBox) {
    const [, , width, height] = viewBox
      .split(/[\s,]+/)
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value));
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height };
    }
  }

  const width = Number.parseFloat(svgElement.getAttribute('width') || '');
  const height = Number.parseFloat(svgElement.getAttribute('height') || '');
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { width, height };
  }

  return null;
}

function createMermaidRenderHost(): HTMLDivElement {
  const renderHost = document.createElement('div');
  renderHost.setAttribute('aria-hidden', 'true');
  renderHost.style.position = 'fixed';
  renderHost.style.top = '0';
  renderHost.style.left = '-100000px';
  renderHost.style.width = 'max-content';
  renderHost.style.height = 'max-content';
  renderHost.style.overflow = 'visible';
  renderHost.style.pointerEvents = 'none';
  renderHost.style.visibility = 'hidden';

  (document.body || document.documentElement).appendChild(renderHost);
  return renderHost;
}

async function renderMermaidDefinition(definition: string): Promise<MermaidRenderSnapshot> {
  const cached = mermaidRenderCache.get(definition);
  if (cached?.promise) {
    return cached.promise;
  }

  const cachedSnapshot = getCachedMermaidRenderSnapshot(definition);
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  const pendingSnapshot = { ...EMPTY_MERMAID_RENDER_SNAPSHOT };
  const promise = (async () => {
    const renderHost = createMermaidRenderHost();

    try {
      const mermaidApi = await loadMermaid();
      const renderId = `mermaid-diagram-${++mermaidRenderSequence}`;
      const { svg, bindFunctions } = await mermaidApi.render(renderId, definition, renderHost);
      const nextSnapshot: MermaidRenderSnapshot = {
        bindFunctions: bindFunctions ?? null,
        error: '',
        svg,
        svgDimensions: getSvgDimensions(svg)
      };

      setCachedMermaidRenderSnapshot(definition, nextSnapshot, null);
      return nextSnapshot;
    } catch (renderError) {
      const errorSnapshot: MermaidRenderSnapshot = {
        ...EMPTY_MERMAID_RENDER_SNAPSHOT,
        error: renderError instanceof Error ? renderError.message : 'Mermaid could not render this diagram.'
      };

      setCachedMermaidRenderSnapshot(definition, errorSnapshot, null);
      return errorSnapshot;
    } finally {
      renderHost.remove();
    }
  })();

  setCachedMermaidRenderSnapshot(definition, pendingSnapshot, promise);
  return promise;
}

function MermaidDiagram({ definition }: { definition: string }) {
  const cachedRenderSnapshot = getCachedMermaidRenderSnapshot(definition);
  const inlineContainerRef = useRef<HTMLDivElement | null>(null);
  const expandedViewportRef = useRef<HTMLDivElement | null>(null);
  const expandedPanTargetRef = useRef<HTMLDivElement | null>(null);
  const expandedContentRef = useRef<HTMLDivElement | null>(null);
  const expandedPanzoomRef = useRef<PanZoomInstance | null>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | null>(cachedRenderSnapshot?.bindFunctions ?? null);
  const [svg, setSvg] = useState(cachedRenderSnapshot?.svg ?? '');
  const [svgDimensions, setSvgDimensions] = useState<SvgDimensions | null>(cachedRenderSnapshot?.svgDimensions ?? null);
  const [error, setError] = useState(cachedRenderSnapshot?.error ?? '');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);

  const closeExpandedViewer = () => {
    setIsExpanded(false);
    setIsLandscape(false);
  };

  useEffect(() => {
    let cancelled = false;
    let frameId = 0;

    const applyRenderSnapshot = (snapshot: MermaidRenderSnapshot) => {
      bindFunctionsRef.current = snapshot.bindFunctions;
      setSvg(snapshot.svg);
      setSvgDimensions(snapshot.svgDimensions);
      setError(snapshot.error);
    };

    const queueBindFunctions = () => {
      const bindFunctions = bindFunctionsRef.current;
      if (!bindFunctions) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        if (!cancelled && inlineContainerRef.current) {
          bindFunctions(inlineContainerRef.current);
        }
      });
    };

    if (!definition.trim()) {
      setSvg('');
      setSvgDimensions(null);
      setError('Diagram is empty.');
      bindFunctionsRef.current = null;
      return () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    const cachedSnapshot = getCachedMermaidRenderSnapshot(definition);
    if (cachedSnapshot) {
      applyRenderSnapshot(cachedSnapshot);
      if (cachedSnapshot.svg) {
        queueBindFunctions();
      }

      return () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    setSvg('');
    setSvgDimensions(null);
    setError('');
    bindFunctionsRef.current = null;

    const renderDiagram = async () => {
      try {
        const nextSnapshot = await renderMermaidDefinition(definition);
        if (cancelled) {
          return;
        }

        applyRenderSnapshot(nextSnapshot);
        if (nextSnapshot.svg) {
          queueBindFunctions();
        }
      } catch {
        applyRenderSnapshot({
          ...EMPTY_MERMAID_RENDER_SNAPSHOT,
          error: 'Mermaid could not render this diagram.'
        });
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [definition]);

  useEffect(() => {
    if (!isExpanded) {
      expandedPanzoomRef.current?.dispose();
      expandedPanzoomRef.current = null;
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeExpandedViewer();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded || !expandedViewportRef.current || !expandedPanTargetRef.current || !expandedContentRef.current || !svg) {
      return;
    }

    let cancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      void (async () => {
        const expandedViewport = expandedViewportRef.current;
        const expandedPanTarget = expandedPanTargetRef.current;
        const expandedContent = expandedContentRef.current;
        if (!expandedViewport || !expandedPanTarget || !expandedContent) {
          return;
        }

        const createPanzoom = await loadPanzoom();
        if (cancelled) {
          return;
        }

        bindFunctionsRef.current?.(expandedContent);

        const svgElement = expandedContent.querySelector('svg');
        if (!(svgElement instanceof SVGElement)) {
          return;
        }

        expandedPanzoomRef.current?.dispose();

        const diagramWidth = svgDimensions?.width || svgElement.viewBox.baseVal.width || svgElement.getBoundingClientRect().width || 1;
        const diagramHeight = svgDimensions?.height || svgElement.viewBox.baseVal.height || svgElement.getBoundingClientRect().height || 1;
        const renderedWidth = isLandscape ? diagramHeight : diagramWidth;
        const renderedHeight = isLandscape ? diagramWidth : diagramHeight;
        const fitWidth = Math.max(1, expandedViewport.clientWidth - 48);
        const fitHeight = Math.max(1, expandedViewport.clientHeight - 48);
        const fitZoom = Math.min(fitWidth / renderedWidth, fitHeight / renderedHeight, 1);
        const initialZoom = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
        const initialX = (expandedViewport.clientWidth - renderedWidth * initialZoom) / 2;
        const initialY = (expandedViewport.clientHeight - renderedHeight * initialZoom) / 2;
        const minZoom = Math.max(0.05, Math.min(0.2, initialZoom * 0.75));

        expandedPanTarget.style.width = `${renderedWidth}px`;
        expandedPanTarget.style.height = `${renderedHeight}px`;
        svgElement.setAttribute('width', String(diagramWidth));
        svgElement.setAttribute('height', String(diagramHeight));
        svgElement.style.width = `${diagramWidth}px`;
        svgElement.style.height = `${diagramHeight}px`;
        svgElement.style.userSelect = 'none';

        expandedPanzoomRef.current = createPanzoom(expandedPanTarget, {
          beforeMouseDown: (mouseEvent) => mouseEvent.button !== 0,
          bounds: true,
          boundsPadding: 0.12,
          disableKeyboardInteraction: true,
          initialX,
          initialY,
          initialZoom,
          maxZoom: 6,
          minZoom,
          pinchSpeed: 1.5,
          smoothScroll: false,
          zoomDoubleClickSpeed: 1
        });
      })();
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      expandedPanzoomRef.current?.dispose();
      expandedPanzoomRef.current = null;
    };
  }, [isExpanded, isLandscape, svg, svgDimensions]);

  if (error) {
    return (
      <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-600">Mermaid Render Failed</div>
        <div className="text-xs leading-5 text-red-700">{error}</div>
        <pre className="overflow-x-auto rounded-lg border border-red-200 bg-white/80 px-3 py-2 text-xs leading-5 whitespace-pre-wrap text-red-950">
          {definition}
        </pre>
      </div>
    );
  }

  return (
    <>
      <div className="group relative overflow-x-auto rounded-xl border border-zinc-200 bg-white px-3 py-3 shadow-sm">
        {svg ? (
          <>
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <button
                type="button"
                aria-label="Expand Mermaid diagram"
                className="pointer-events-auto inline-flex h-10 items-center gap-1.5 rounded-full border border-zinc-200 bg-white/95 px-3 text-xs font-medium text-zinc-700 shadow-sm transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 hover:border-zinc-300 hover:text-zinc-950 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60"
                onClick={() => setIsExpanded(true)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M6 3.5H3.5V6M10 3.5h2.5V6M6 12.5H3.5V10M10 12.5h2.5V10" strokeLinecap="round" />
                  <path d="M3.5 6 6.8 2.7M12.5 6 9.2 2.7M3.5 10l3.3 3.3M12.5 10l-3.3 3.3" strokeLinecap="round" />
                </svg>
                <span>Zoom</span>
              </button>
            </div>
            <div
              ref={inlineContainerRef}
              className="[&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </>
        ) : (
          <div className="text-xs text-zinc-500">Rendering diagram...</div>
        )}
      </div>

      {isExpanded ? (
        <div
          className="fixed inset-0 z-50 bg-zinc-950/72 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeExpandedViewer();
            }
          }}
        >
          <div
            className="relative h-full w-full px-3 pb-3 sm:px-6 sm:pb-6"
            style={{
              paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
              paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
              paddingLeft: 'max(0.75rem, env(safe-area-inset-left))'
            }}
          >
            <div className="pointer-events-none absolute top-0 right-0 z-10 flex items-center gap-2 p-3 sm:p-4">
              <button
                type="button"
                aria-label={isLandscape ? 'Restore vertical Mermaid diagram' : 'Rotate Mermaid diagram to landscape'}
                aria-pressed={isLandscape}
                className={`pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border bg-white/96 shadow-lg transition focus:outline-none focus:ring-2 focus:ring-zinc-300/80 ${
                  isLandscape ? 'border-zinc-900 text-zinc-950' : 'border-zinc-200 text-zinc-700 hover:border-zinc-300 hover:text-zinc-950'
                }`}
                onClick={() => setIsLandscape((current) => !current)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="5" width="10" height="6" rx="1.5" />
                  <path d="M5.2 3.2 3.5 5l1.7 1.8M10.8 12.8 12.5 11l-1.7-1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Close Mermaid diagram"
                className="pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border border-zinc-200 bg-white/96 text-zinc-700 shadow-lg transition hover:border-zinc-300 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-300/80"
                onClick={closeExpandedViewer}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 4l8 8M12 4 4 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div
              ref={expandedViewportRef}
              className="relative h-full w-full overflow-hidden rounded-2xl bg-white/96 shadow-2xl ring-1 ring-black/5 touch-none"
            >
              <div ref={expandedPanTargetRef} className="absolute top-0 left-0">
                <div
                  ref={expandedContentRef}
                  className="absolute top-1/2 left-1/2 [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none"
                  style={{
                    height: svgDimensions?.height ? `${svgDimensions.height}px` : undefined,
                    transform: isLandscape ? 'translate(-50%, -50%) rotate(90deg)' : 'translate(-50%, -50%)',
                    transformOrigin: 'center center',
                    width: svgDimensions?.width ? `${svgDimensions.width}px` : undefined
                  }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const MarkdownTextSegment = memo(function MarkdownTextSegment({
  content,
  tone = 'default'
}: {
  content: string;
  tone?: 'default' | 'inverse' | 'muted';
}) {
  const isInverse = tone === 'inverse';
  const isMuted = tone === 'muted';

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ ...props }) => (
          <a
            {...props}
            className={
              isInverse
                ? 'text-sky-900 underline underline-offset-2'
                : isMuted
                  ? 'text-zinc-500 underline underline-offset-2'
                  : 'text-blue-700 underline underline-offset-2'
            }
            target="_blank"
            rel="noreferrer"
          />
        ),
        blockquote: ({ ...props }) => (
          <blockquote
            {...props}
            className={
              isInverse
                ? 'border-l-2 border-sky-300 pl-3 leading-[1.5] text-zinc-700'
                : isMuted
                  ? 'border-l-2 border-zinc-200 pl-3 leading-[1.5] text-zinc-500'
                  : 'border-l-2 border-zinc-300 pl-3 leading-[1.5] text-zinc-600'
            }
          />
        ),
        code: ({ children, className, ...props }) => {
          const codeContent = getMarkdownTextContent(children);
          const isBlock = Boolean(className) || codeContent.includes('\n');
          if (isBlock) {
            const codeClassName = [
              className,
              isInverse
                ? 'block overflow-x-auto rounded-xl border border-sky-200 bg-sky-100 px-4 py-3 text-xs leading-5 text-zinc-900'
                : isMuted
                  ? 'block overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-100 px-4 py-3 text-xs leading-5 text-zinc-600 not-italic'
                  : 'block overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-100 px-4 py-3 text-xs leading-5 text-zinc-800'
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <code {...props} className={codeClassName}>
                {children}
              </code>
            );
          }

          return (
            <code
              {...props}
              className={
                isInverse
                  ? 'rounded bg-sky-100 px-1.5 py-0.5 text-[0.85em] text-zinc-900'
                  : isMuted
                    ? 'rounded bg-zinc-100 px-1.5 py-0.5 text-[0.85em] text-zinc-600 not-italic'
                    : 'rounded bg-zinc-200 px-1.5 py-0.5 text-[0.85em] text-zinc-900'
              }
            >
              {children}
            </code>
          );
        },
        h1: ({ ...props }) => (
          <h1
            {...props}
            className={isMuted ? 'text-lg font-semibold leading-tight text-zinc-600 italic' : 'text-lg font-semibold leading-tight text-zinc-950'}
          />
        ),
        h2: ({ ...props }) => (
          <h2
            {...props}
            className={isMuted ? 'text-base font-semibold leading-tight text-zinc-600 italic' : 'text-base font-semibold leading-tight text-zinc-950'}
          />
        ),
        h3: ({ ...props }) => (
          <h3
            {...props}
            className={isMuted ? 'text-sm font-semibold leading-tight text-zinc-600 italic' : 'text-sm font-semibold leading-tight text-zinc-950'}
          />
        ),
        li: ({ ...props }) => <li {...props} className="ml-5 list-item leading-[1.45]" />,
        ol: ({ ...props }) => <ol {...props} className="list-decimal space-y-0 pl-5" />,
        p: ({ ...props }) => <p {...props} className="whitespace-pre-wrap break-words leading-[1.5]" />,
        pre: ({ ...props }) => (
          <pre
            {...props}
            className={
              isInverse
                ? 'overflow-x-auto rounded-xl border border-sky-200 bg-sky-100'
                : isMuted
                  ? 'overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-100 text-zinc-600 not-italic'
                  : 'overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-100'
            }
          />
        ),
        table: ({ ...props }) => (
          <div className="my-2 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
            <table
              {...props}
              className={
                isInverse
                  ? 'min-w-full border-collapse text-sm text-zinc-900'
                  : isMuted
                    ? 'min-w-full border-collapse text-sm text-zinc-600 not-italic'
                    : 'min-w-full border-collapse text-sm text-zinc-800'
              }
            />
          </div>
        ),
        tbody: ({ ...props }) => <tbody {...props} className={isMuted ? 'bg-zinc-50/50' : 'bg-white'} />,
        td: ({ ...props }) => (
          <td
            {...props}
            className={
              isInverse
                ? 'border border-sky-200 bg-white/70 px-3 py-2 align-top'
                : isMuted
                  ? 'border border-zinc-200 px-3 py-2 align-top text-zinc-600 not-italic'
                  : 'border border-zinc-200 px-3 py-2 align-top'
            }
          />
        ),
        th: ({ ...props }) => (
          <th
            {...props}
            className={
              isInverse
                ? 'border border-sky-200 bg-sky-50 px-3 py-2 text-left font-semibold text-zinc-950'
                : isMuted
                  ? 'border border-zinc-200 bg-zinc-100 px-3 py-2 text-left font-semibold text-zinc-700 not-italic'
                  : 'border border-zinc-200 bg-zinc-50 px-3 py-2 text-left font-semibold text-zinc-950'
            }
          />
        ),
        thead: ({ ...props }) => <thead {...props} className="sticky top-0" />,
        tr: ({ ...props }) => <tr {...props} className="align-top" />,
        ul: ({ ...props }) => <ul {...props} className="list-disc space-y-0 pl-5" />
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

const MessageMarkdown = memo(function MessageMarkdown({
  content,
  tone = 'default'
}: {
  content: string;
  tone?: 'default' | 'inverse' | 'muted';
}) {
  const isInverse = tone === 'inverse';
  const isMuted = tone === 'muted';
  const hasMermaidFence = useMemo(() => containsMermaidFence(content), [content]);
  const renderSegments = useMemo(() => getMarkdownRenderSegments(content), [content]);

  useLayoutEffect(() => {
    if (!hasMermaidFence) {
      return;
    }

    void loadMermaid();
    for (const segment of renderSegments) {
      if (segment.type === 'mermaid') {
        void renderMermaidDefinition(segment.definition);
      }
    }
  }, [hasMermaidFence, renderSegments]);

  return (
    <div
      className={[
        'markdown-body max-w-full space-y-1.5 leading-[1.5]',
        isInverse ? 'text-zinc-950' : isMuted ? 'text-zinc-500 italic' : 'text-zinc-800'
      ].join(' ')}
    >
      {renderSegments.length === 0
        ? null
        : renderSegments.map((segment) =>
            segment.type === 'mermaid' ? (
              <MermaidDiagram key={segment.key} definition={segment.definition} />
            ) : (
              <MarkdownTextSegment key={segment.key} content={segment.content} tone={tone} />
            )
          )}
    </div>
  );
});

function getToolInputPreview(input: string, maxChars = 180): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no input)';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

function parseStructuredToolInput(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function getStructuredToolInputField(input: string, field: string): string | null {
  const parsed = parseStructuredToolInput(input);
  const value = parsed?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getStructuredToolInputStringArray(input: string, field: string): string[] {
  const parsed = parseStructuredToolInput(input);
  const value = parsed?.[field];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractPatchFileLabels(input: string, maxFiles = 2): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const matcher = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm;
  let match: RegExpExecArray | null = null;

  while ((match = matcher.exec(input)) !== null) {
    const filePath = (match[1] ?? '').trim();
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    files.push(filePath);
    if (files.length >= maxFiles) {
      break;
    }
  }

  return files;
}

type ToolVariantTone = 'generic' | 'mcp' | 'shell' | 'web';

function getToolVariant(toolName: string | undefined): { tone: ToolVariantTone } {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { tone: 'generic' };
  }

  if (
    lower.includes('bash') ||
    lower.includes('shell') ||
    lower.includes('terminal') ||
    lower === 'exec_command' ||
    lower.endsWith('.exec_command')
  ) {
    return { tone: 'shell' };
  }

  if (lower.includes('websearch') || lower.includes('fetch') || lower.startsWith('web')) {
    return { tone: 'web' };
  }

  if (lower.startsWith('mcp__')) {
    return { tone: 'mcp' };
  }

  return { tone: 'generic' };
}

function getCompactToolTitle(toolName: string | undefined, input: string): string {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (normalized === 'Task') {
    const subagentType = getStructuredToolInputField(input, 'subagent_type');
    const description = getStructuredToolInputField(input, 'description');

    if (subagentType && description) {
      return `${subagentType}(${description})`;
    }

    if (description) {
      return description;
    }

    if (subagentType) {
      return subagentType;
    }
  }

  if (lower === 'exec_command' || lower.endsWith('.exec_command') || lower === 'shell_command' || lower.endsWith('.shell_command')) {
    return 'Ran';
  }

  if (lower === 'apply_patch' || lower.endsWith('.apply_patch')) {
    return 'Edited';
  }

  if (!normalized) {
    return 'Tool';
  }

  return normalized;
}

function getCompactToolPreview(toolName: string | undefined, input: string, maxChars = 180): string {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (normalized === 'Task') {
    const prompt = getStructuredToolInputField(input, 'prompt');
    if (prompt) {
      return getToolInputPreview(prompt, maxChars);
    }
  }

  if (lower === 'exec_command' || lower.endsWith('.exec_command') || lower === 'shell_command' || lower.endsWith('.shell_command')) {
    const command = getStructuredToolInputField(input, 'cmd') ?? getStructuredToolInputField(input, 'command');
    if (command) {
      return getToolInputPreview(command, maxChars);
    }
  }

  if (lower === 'apply_patch' || lower.endsWith('.apply_patch')) {
    const patchFiles = extractPatchFileLabels(input, 2);
    if (patchFiles.length === 1) {
      return patchFiles[0];
    }
    if (patchFiles.length > 1) {
      return `${patchFiles.join(', ')} ...`;
    }
  }

  return getToolInputPreview(input, maxChars);
}

function getToolToneClasses(_tone: ToolVariantTone): {
  badge: string;
  border: string;
  meta: string;
  surface: string;
  title: string;
} {
  return {
    badge: 'border border-zinc-300 bg-white text-zinc-950',
    border: 'border-zinc-200',
    meta: 'text-zinc-500',
    surface: 'bg-white',
    title: 'text-zinc-900'
  };
}

function ToolStatusIcon({ status }: { status: MessageStatus }) {
  if (status === 'error') {
    return <span className="inline-block h-2 w-2 rounded-full bg-red-600" />;
  }
  if (status === 'complete') {
    return <span className="inline-block h-2 w-2 rounded-full bg-emerald-600" />;
  }
  return (
    <span className="relative inline-flex h-3 w-3 items-center justify-center">
      <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-emerald-600/30" />
      <span className="relative inline-block h-2 w-2 rounded-full bg-emerald-600" />
    </span>
  );
}

function ToolDetailSection({ label, children }: { children: React.ReactNode; label: string }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      {children}
    </section>
  );
}

function MessageAttachmentGallery({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.attachmentId}
          className="overflow-hidden rounded-xl border border-zinc-200 bg-white"
        >
          {attachment.previewUrl && attachment.mimeType.startsWith('image/') ? (
            <img src={attachment.previewUrl} alt={attachment.filename} className="max-h-48 w-auto max-w-full object-contain" />
          ) : (
            <div className="flex min-h-20 min-w-40 items-center justify-center px-3 py-4 text-sm text-zinc-500">
              {attachment.filename}
            </div>
          )}
          <div className="border-t border-zinc-200/80 bg-zinc-50 px-2.5 py-1.5 text-[11px] text-zinc-600">
            <div className="truncate font-medium text-zinc-700">{attachment.filename}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function getMessageTextBlocks(message: ChatMessage): Extract<ChatMessageBlock, { type: 'text' }>[] {
  return message.blocks.filter((block): block is Extract<ChatMessageBlock, { type: 'text' }> => block.type === 'text');
}

function getMessagePlainText(message: ChatMessage): string {
  return getMessageTextBlocks(message)
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function hasToolUseBlock(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'tool_use');
}

function getFirstToolUseBlock(message: ChatMessage): ToolUseChatMessageBlock | null {
  return message.blocks.find((block): block is ToolUseChatMessageBlock => block.type === 'tool_use') ?? null;
}

function normalizeActivityTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function terminalFrameLineToText(line: TerminalFrameLine): string {
  return line.runs.map((run) => run.text).join('');
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTerminalViewportLines(snapshot: TerminalFrameSnapshot | null | undefined): string[] {
  if (!snapshot || snapshot.lines.length === 0) {
    return [];
  }

  const viewportStart = Math.max(0, snapshot.viewportY - snapshot.tailStart);
  const viewportEnd = Math.min(snapshot.lines.length, viewportStart + Math.max(snapshot.rows, 1));
  const viewportLines = snapshot.lines.slice(viewportStart, viewportEnd);

  return viewportLines
    .map((line) => terminalFrameLineToText(line).replace(/\u00a0/g, ' ').replace(/\s+$/g, ''))
    .filter((line, index, lines) => line.length > 0 || index === lines.length - 1);
}

function buildTerminalApprovalShortcut(index: number): string {
  if (index <= 0) {
    return 'Enter';
  }

  return `${'↓ '.repeat(index).trim()} Enter`;
}

function createTerminalApprovalOption(index: number, label: string): ApprovalOption {
  return {
    id: `terminal:${index}`,
    input: `${'\x1b[B'.repeat(index)}\r`,
    label,
    shortcut: buildTerminalApprovalShortcut(index)
  };
}

function parseTerminalApprovalOptions(lines: string[]): ApprovalOption[] {
  const options = new Map<number, ApprovalOption>();

  for (const line of lines) {
    const normalizedLine = line.replace(/^[>\u203a\u25b8\u25b6*\-]+\s*/, '');
    const match = normalizedLine.match(/^\s*(\d+)\.\s+(.+?)\s*(?:\(([a-z])\))?\s*$/i);
    if (!match) {
      continue;
    }

    const rawIndex = Number.parseInt(match[1] ?? '', 10);
    const label = (match[2] ?? '').trim();
    if (!Number.isFinite(rawIndex) || rawIndex <= 0 || !label) {
      continue;
    }

    options.set(rawIndex - 1, createTerminalApprovalOption(rawIndex - 1, label));
  }

  return Array.from(options.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, option]) => option);
}

function normalizeApprovalOptionLabel(label: string): string {
  return normalizeTerminalText(label).toLowerCase();
}

function hasKnownTerminalApprovalOptions(options: ApprovalOption[]): boolean {
  if (options.length === 0) {
    return false;
  }

  const labels = new Set(options.map((option) => normalizeApprovalOptionLabel(option.label)));
  return KNOWN_TERMINAL_APPROVAL_OPTION_LABELS.every((label) => labels.has(label));
}

function isTerminalApprovalTitleLine(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes('would you like to run the following command?') ||
    lower.includes('do you want to approve network access to ') ||
    lower.includes('would you like to make the following edits?') ||
    lower.includes('would you like to grant these permissions?') ||
    lower.endsWith('needs your approval.') ||
    (/^allow (?:the )?.+\bto run tool\b.+\?$/.test(lower) && lower.includes('mcp server'))
  );
}

function findTerminalApprovalTitleMatch(
  normalizedLines: string[]
): { index: number; title: string } | null {
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const currentLine = normalizedLines[index] ?? '';
    if (isTerminalApprovalTitleLine(currentLine)) {
      return {
        index,
        title: currentLine
      };
    }

    const nextLine = normalizedLines[index + 1];
    if (!nextLine) {
      continue;
    }

    const mergedLine = normalizeTerminalText(`${currentLine} ${nextLine}`);
    if (isTerminalApprovalTitleLine(mergedLine)) {
      return {
        index,
        title: mergedLine
      };
    }
  }

  return null;
}

function findTerminalApprovalFallbackMatch(
  normalizedLines: string[],
  options: ApprovalOption[]
): { index: number; title: string } | null {
  if (!hasKnownTerminalApprovalOptions(options)) {
    return null;
  }

  const firstOptionIndex = normalizedLines.findIndex((line) => /^\s*\d+\.\s+/.test(line));
  if (firstOptionIndex === -1) {
    return null;
  }

  for (let index = firstOptionIndex - 1; index >= 0; index -= 1) {
    const line = normalizedLines[index];
    if (!line) {
      continue;
    }

    return {
      index,
      title: line
    };
  }

  return {
    index: firstOptionIndex,
    title: 'Pending approval in terminal'
  };
}

function findLatestOpenToolCallId(messages: ChatMessage[], toolCallIndex: Map<string, ToolCallMeta>): string | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex];
      if (block.type !== 'tool_use' || !block.toolCallId) {
        continue;
      }

      if (!toolCallIndex.get(block.toolCallId)?.resultBlock) {
        return block.toolCallId;
      }
    }
  }

  return null;
}

function detectTerminalSideChannelState(
  frameSnapshot: TerminalFrameSnapshot | null | undefined,
  relatedToolCallId: string | null
): TerminalSideChannelState {
  const viewportLines = getTerminalViewportLines(frameSnapshot);
  if (viewportLines.length === 0) {
    return {
      approval: null,
      interrupted: null
    };
  }

  const normalizedLines = viewportLines.map((line) => normalizeTerminalText(line));
  const joinedText = normalizedLines.join(' ').toLowerCase();

  const interrupted =
    joinedText.includes('conversation interrupted') &&
    joinedText.includes('tell the model what to do differently')
      ? {
          confidence: 'high' as const,
          message: 'Conversation interrupted. This state is observed from the live terminal screen.',
          relatedToolCallId
        }
      : null;

  const options = parseTerminalApprovalOptions(normalizedLines);
  const approvalTitleMatch =
    findTerminalApprovalTitleMatch(normalizedLines) ?? findTerminalApprovalFallbackMatch(normalizedLines, options);
  const approvalTitleIndex = approvalTitleMatch?.index ?? -1;

  if (approvalTitleIndex === -1) {
    return {
      approval: null,
      interrupted
    };
  }

  const firstOptionIndex = normalizedLines.findIndex((line) => /^\s*\d+\.\s+/.test(line));
  const contextLines = normalizedLines
    .slice(approvalTitleIndex + 1, firstOptionIndex >= 0 ? firstOptionIndex : approvalTitleIndex + 5)
    .filter(Boolean)
    .slice(0, 4);

  const approval: TerminalApprovalState = {
    confidence: options.length >= 2 ? 'high' : 'medium',
    contextLines,
    options,
    relatedToolCallId,
    title: approvalTitleMatch?.title ?? normalizedLines[approvalTitleIndex] ?? 'Pending approval in terminal'
  };

  return {
    approval: isInterruptedApprovalSuppressed(approval.relatedToolCallId, interrupted) ? null : approval,
    interrupted
  };
}

function isInterruptedApprovalSuppressed(
  toolCallId: string | null | undefined,
  interrupted: TerminalInterruptedState | null | undefined
): boolean {
  return Boolean(toolCallId && interrupted?.relatedToolCallId && toolCallId === interrupted.relatedToolCallId);
}

function mergeToolCallUiState(
  messages: ChatMessage[],
  toolCallIndex: Map<string, ToolCallMeta>,
  terminalSideChannel: TerminalSideChannelState
): MergedChatToolState {
  const toolCallUiStateIndex = new Map<string, ToolCallUiState>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || !block.toolCallId) {
        continue;
      }

      const toolCallId = block.toolCallId;
      const current = toolCallUiStateIndex.get(toolCallId);
      const hasResult = current?.hasResult ?? Boolean(toolCallIndex.get(toolCallId)?.resultBlock);

      toolCallUiStateIndex.set(toolCallId, {
        hasResult,
        interrupted: current?.interrupted ?? null,
        terminalApproval: current?.terminalApproval ?? null
      });
    }
  }

  const interrupted = terminalSideChannel.interrupted;
  const interruptedToolCallId = interrupted?.relatedToolCallId ?? null;
  if (interruptedToolCallId && toolCallUiStateIndex.has(interruptedToolCallId)) {
    const current = toolCallUiStateIndex.get(interruptedToolCallId);
    if (current) {
      toolCallUiStateIndex.set(interruptedToolCallId, {
        ...current,
        interrupted,
        terminalApproval: null
      });
    }
  }

  const approval = terminalSideChannel.approval;
  const approvalToolCallId = approval?.relatedToolCallId ?? null;
  if (approval && approvalToolCallId && toolCallUiStateIndex.has(approvalToolCallId)) {
    const current = toolCallUiStateIndex.get(approvalToolCallId);
    if (current && !current.hasResult && !current.interrupted) {
      toolCallUiStateIndex.set(approvalToolCallId, {
        ...current,
        terminalApproval: approval
      });
    }
  }

  const approvalNotice =
    approval && (!approvalToolCallId || !toolCallUiStateIndex.has(approvalToolCallId))
      ? approval
      : null;

  return {
    approvalNotice,
    interruptedNotice: interrupted,
    toolCallUiStateIndex
  };
}

function hasNonTextBlock(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type !== 'text');
}

function MessageShell({ message, children }: { children: React.ReactNode; message: ChatMessage }) {
  if (hasNonTextBlock(message)) {
    return <>{children}</>;
  }

  const wrapperClass = message.role === 'user' ? 'flex justify-end' : 'flex justify-start';
  const shellClass =
    message.role === 'user'
      ? 'w-fit max-w-[85%] rounded-2xl bg-sky-200 px-3.5 py-2.5 text-sm break-words text-zinc-950 shadow-sm'
      : message.status === 'error'
        ? 'w-fit max-w-[85%] rounded-2xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm break-words text-zinc-900 shadow-sm'
        : 'w-full max-w-[44rem] py-2.5 text-sm break-words text-zinc-900';

  return (
    <div className={wrapperClass}>
      <article className={shellClass}>{children}</article>
    </div>
  );
}

function createToolCallIndex(messages: ChatMessage[]): Map<string, ToolCallMeta> {
  const index = new Map<string, ToolCallMeta>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.toolCallId) {
        index.set(block.toolCallId, {
          ...index.get(block.toolCallId),
          toolName: block.toolName,
          useBlockId: block.id
        });
      }

      if (block.type === 'tool_result' && block.toolCallId) {
        index.set(block.toolCallId, {
          ...index.get(block.toolCallId),
          resultBlock: block,
          resultStatus: block.isError ? 'error' : 'complete'
        });
      }
    }
  }

  return index;
}

function hasRenderableMessageContent(message: ChatMessage): boolean {
  if ((message.attachments?.length ?? 0) > 0) {
    return true;
  }

  return message.blocks.some((block) => {
    if (block.type === 'tool_use') {
      return true;
    }

    if (block.type === 'text') {
      return Boolean(block.text.trim());
    }

    return false;
  });
}

function TextBlockContent({
  block,
  tone
}: {
  block: Extract<ChatMessageBlock, { type: 'text' }>;
  tone?: 'default' | 'inverse' | 'muted';
}) {
  return <MessageMarkdown content={block.text} tone={tone} />;
}

function resolveToolUseStatus(
  block: ToolUseChatMessageBlock,
  toolCallIndex: Map<string, ToolCallMeta>,
  fallbackStatus: MessageStatus
): MessageStatus {
  if (!block.toolCallId) {
    return fallbackStatus;
  }

  return toolCallIndex.get(block.toolCallId)?.resultStatus ?? fallbackStatus;
}

function TerminalInterruptedBanner({ interrupted }: { interrupted: TerminalInterruptedState }) {
  return (
    <section className="rounded-2xl border border-red-200 bg-red-50/85 px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-red-600" />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-zinc-950">Interrupted</div>
          <div className="text-sm leading-6 text-zinc-700">{interrupted.message}</div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Source: terminal side-channel</div>
        </div>
      </div>
    </section>
  );
}

function TerminalApprovalInlineNotice({
  approval,
  canSendApprovalInput,
  onApprovalInput
}: {
  approval: TerminalApprovalState;
  canSendApprovalInput: boolean;
  onApprovalInput?: (input: string) => void;
}) {
  return (
    <section className="mt-2 overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/85 shadow-sm">
      <div className="border-b border-amber-200/80 px-4 py-3">
        <div className="text-sm font-semibold text-zinc-950">Pending approval in terminal</div>
        <div className="mt-1 text-xs leading-5 text-zinc-600">This state is inferred from the current PTY screen, not from JSONL.</div>
      </div>

      <div className="space-y-3 px-4 py-4">
        <div className="rounded-xl border border-amber-200 bg-white/80 px-3 py-2 text-sm leading-6 text-zinc-800">
          {approval.title}
        </div>

        {approval.contextLines.length > 0 ? (
          <pre className="overflow-auto rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-5 whitespace-pre-wrap break-all text-zinc-700">
            {approval.contextLines.join('\n')}
          </pre>
        ) : null}

        {approval.options.length > 0 ? (
          <div className="space-y-2">
            {approval.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                disabled={!canSendApprovalInput || !onApprovalInput}
                onClick={() => {
                  onApprovalInput?.(option.input);
                }}
                className={[
                  'flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-3 text-left transition',
                  canSendApprovalInput && onApprovalInput
                    ? option.label.toLowerCase().startsWith('no')
                      ? 'border-zinc-200 bg-white hover:border-red-300 hover:bg-red-50/60'
                      : 'border-zinc-200 bg-white hover:border-amber-300 hover:bg-amber-100/60'
                    : 'cursor-not-allowed border-zinc-200 bg-zinc-100 text-zinc-400 opacity-80'
                ].join(' ')}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-zinc-900">
                    {index + 1}. {option.label}
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
                  {option.shortcut}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white/70 px-3 py-2 text-xs leading-5 text-zinc-500">
            Approval options were not parsed from the current terminal viewport. Continue in the terminal.
          </div>
        )}
      </div>
    </section>
  );
}

function ToolUseBlockContent({
  block,
  canSendApprovalInput,
  resultBlock,
  status,
  terminalApproval,
  onApprovalInput
}: {
  block: ToolUseChatMessageBlock;
  canSendApprovalInput?: boolean;
  resultBlock?: ToolResultChatMessageBlock;
  status: MessageStatus;
  terminalApproval?: TerminalApprovalState | null;
  onApprovalInput?: (input: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const variant = getToolVariant(block.toolName);
  const compactTitle = getCompactToolTitle(block.toolName, block.input);
  const toneClasses = getToolToneClasses(variant.tone);
  const summaryPreview = getCompactToolPreview(block.toolName, block.input, 112);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsExpanded(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpanded]);

  return (
    <>
      <div className="flex justify-start">
        <button
          type="button"
          className={`w-full overflow-hidden rounded-lg border px-3 py-2 text-left shadow-sm transition hover:border-zinc-300 ${toneClasses.border} ${toneClasses.surface}`}
          onClick={() => setIsExpanded(true)}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                <ToolStatusIcon status={status} />
              </div>
              <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                <div className={`shrink-0 text-[11px] font-medium ${toneClasses.title}`}>{compactTitle}</div>
                <div className={`min-w-0 flex-1 truncate font-mono text-[11px] ${toneClasses.meta}`}>{summaryPreview || '(no input)'}</div>
              </div>
            </div>
            <span className="shrink-0 text-zinc-700">
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="m4.5 6.5 3.5 3 3.5-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </button>
      </div>

      {terminalApproval ? (
        <TerminalApprovalInlineNotice
          approval={terminalApproval}
          canSendApprovalInput={Boolean(canSendApprovalInput)}
          onApprovalInput={onApprovalInput}
        />
      ) : null}

      {isExpanded ? (
        <div className="fixed inset-0 z-50 bg-zinc-950/72 backdrop-blur-sm" onClick={() => setIsExpanded(false)}>
          <div
            className="flex h-full w-full items-end px-3 pb-3 sm:items-center sm:px-6 sm:pb-6"
            style={{
              paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
              paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
              paddingLeft: 'max(0.75rem, env(safe-area-inset-left))'
            }}
          >
            <div
              className="relative w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 sm:mx-auto"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 sm:px-5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <ToolStatusIcon status={status} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-zinc-950">{compactTitle}</div>
                    {block.toolName && block.toolName !== compactTitle ? (
                      <div className="truncate font-mono text-[11px] text-zinc-500">{block.toolName}</div>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close tool details"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 transition hover:border-zinc-300 hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-300/80"
                  onClick={() => setIsExpanded(false)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M4 4l8 8M12 4 4 12" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="max-h-[min(75vh,40rem)] space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
                <ToolDetailSection label="Input">
                  <pre className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-[11px] leading-5 whitespace-pre-wrap break-all text-zinc-700">
                    {block.input || '(no input)'}
                  </pre>
                </ToolDetailSection>
                <ToolDetailSection label="Output">
                  {resultBlock ? (
                    resultBlock.content ? (
                      <pre className="overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-[11px] leading-5 whitespace-pre-wrap break-all text-zinc-700">
                        {resultBlock.content}
                      </pre>
                    ) : (
                      <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs text-zinc-500">
                        Empty output.
                      </div>
                    )
                  ) : (
                    <div className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs text-zinc-500">
                      {status === 'streaming' ? 'Waiting for output.' : 'No output.'}
                    </div>
                  )}
                </ToolDetailSection>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function isCodexReasoningMessage(message: ChatMessage): boolean {
  return message.id.startsWith('codex:assistant_reasoning:');
}

function isCodexCommentaryMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.meta?.phase === 'commentary' && Boolean(getMessagePlainText(message));
}

function isCodexFinalAnswerMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.meta?.phase === 'final_answer';
}

function createActivityGroupStatus(entries: ChatMessage[]): MessageStatus {
  if (entries.some((entry) => entry.status === 'error')) {
    return 'error';
  }
  if (entries.some((entry) => entry.status === 'streaming')) {
    return 'streaming';
  }
  return 'complete';
}

function createActivityGroupTitle(anchorMessage: ChatMessage | undefined, entries: ChatMessage[]): string {
  const anchorText = anchorMessage ? normalizeActivityTitle(getMessagePlainText(anchorMessage)) : '';
  if (anchorText) {
    return anchorText;
  }

  const firstToolUseBlock = entries.map((entry) => getFirstToolUseBlock(entry)).find(Boolean);
  if (firstToolUseBlock) {
    const compactTitle = getCompactToolTitle(firstToolUseBlock.toolName, firstToolUseBlock.input);
    const compactPreview = getCompactToolPreview(firstToolUseBlock.toolName, firstToolUseBlock.input, 88);
    return normalizeActivityTitle(`${compactTitle}: ${compactPreview}`);
  }

  return 'Activity';
}

function createActivityGroup(
  turnId: string,
  sequenceIndex: number,
  entries: ChatMessage[],
  anchorMessage?: ChatMessage
): ActivityGroup {
  return {
    anchorMessage,
    createdAt: anchorMessage?.createdAt ?? entries[0]?.createdAt ?? new Date(0).toISOString(),
    entries,
    id: anchorMessage ? `activity:${anchorMessage.id}` : `activity:${entries[0]?.id ?? `${turnId}:${sequenceIndex}`}`,
    status: createActivityGroupStatus(entries),
    title: createActivityGroupTitle(anchorMessage, entries),
    turnId
  };
}

function buildCodexDisplayItems(messages: ChatMessage[]): ChatPaneDisplayItem[] {
  const items: ChatPaneDisplayItem[] = [];
  const sequenceByTurnId = new Map<string, number>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === 'user' || isCodexReasoningMessage(message) || isCodexFinalAnswerMessage(message)) {
      items.push({ type: 'message', message });
      continue;
    }

    const turnId = message.meta?.turnId?.trim();
    if (!turnId) {
      items.push({ type: 'message', message });
      continue;
    }

    if (isCodexCommentaryMessage(message)) {
      const entries: ChatMessage[] = [];
      let cursor = index + 1;

      while (cursor < messages.length) {
        const nextMessage = messages[cursor];
        const nextTurnId = nextMessage.meta?.turnId?.trim();
        if (
          nextMessage.role === 'user' ||
          nextTurnId !== turnId ||
          isCodexReasoningMessage(nextMessage) ||
          isCodexCommentaryMessage(nextMessage) ||
          isCodexFinalAnswerMessage(nextMessage)
        ) {
          break;
        }

        entries.push(nextMessage);
        cursor += 1;
      }

      if (entries.length > 0) {
        const sequenceIndex = (sequenceByTurnId.get(turnId) ?? 0) + 1;
        sequenceByTurnId.set(turnId, sequenceIndex);
        items.push({ type: 'activity_group', group: createActivityGroup(turnId, sequenceIndex, entries, message) });
        index = cursor - 1;
        continue;
      }

      items.push({ type: 'message', message });
      continue;
    }

    if (hasToolUseBlock(message)) {
      const entries: ChatMessage[] = [message];
      let cursor = index + 1;

      while (cursor < messages.length) {
        const nextMessage = messages[cursor];
        const nextTurnId = nextMessage.meta?.turnId?.trim();
        if (
          nextMessage.role === 'user' ||
          nextTurnId !== turnId ||
          isCodexReasoningMessage(nextMessage) ||
          isCodexCommentaryMessage(nextMessage) ||
          isCodexFinalAnswerMessage(nextMessage)
        ) {
          break;
        }

        entries.push(nextMessage);
        cursor += 1;
      }

      if (entries.length > 1) {
        const sequenceIndex = (sequenceByTurnId.get(turnId) ?? 0) + 1;
        sequenceByTurnId.set(turnId, sequenceIndex);
        items.push({ type: 'activity_group', group: createActivityGroup(turnId, sequenceIndex, entries) });
        index = cursor - 1;
        continue;
      }
    }

    items.push({ type: 'message', message });
  }

  return items;
}

function MessageContent({
  canSendApprovalInput = false,
  message,
  mergedToolState,
  onApprovalInput,
  toolCallIndex
}: {
  canSendApprovalInput?: boolean;
  message: ChatMessage;
  mergedToolState: MergedChatToolState;
  onApprovalInput?: (input: string) => void;
  toolCallIndex: Map<string, ToolCallMeta>;
}) {
  if (message.blocks.length === 0 && (message.attachments?.length ?? 0) === 0) {
    return null;
  }

  const isReasoning = isCodexReasoningMessage(message);

  return (
    <div className="space-y-2">
      {message.attachments && message.attachments.length > 0 ? (
        <MessageAttachmentGallery attachments={message.attachments} />
      ) : null}
      {message.blocks.map((block) => {
        if (block.type === 'text') {
          return (
            <TextBlockContent
              key={block.id}
              block={block}
              tone={isReasoning ? 'muted' : message.role === 'user' ? 'inverse' : 'default'}
            />
          );
        }

        if (block.type === 'tool_use') {
          const toolMeta = block.toolCallId ? toolCallIndex.get(block.toolCallId) : undefined;
          const toolUiState = block.toolCallId ? mergedToolState.toolCallUiStateIndex.get(block.toolCallId) ?? null : null;
          const hasResult = toolUiState?.hasResult ?? Boolean(toolMeta?.resultBlock);
          const terminalApproval = toolUiState?.terminalApproval ?? null;
          return (
            <ToolUseBlockContent
              key={block.id}
              block={block}
              canSendApprovalInput={canSendApprovalInput}
              onApprovalInput={onApprovalInput}
              status={resolveToolUseStatus(block, toolCallIndex, message.status)}
              resultBlock={toolMeta?.resultBlock}
              terminalApproval={hasResult ? null : terminalApproval}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

function ActivityGroupCard({
  canSendApprovalInput,
  group,
  mergedToolState,
  onApprovalInput,
  toolCallIndex
}: {
  canSendApprovalInput?: boolean;
  group: ActivityGroup;
  mergedToolState: MergedChatToolState;
  onApprovalInput?: (input: string) => void;
  toolCallIndex: Map<string, ToolCallMeta>;
}) {
  const hasPendingApproval = useMemo(
    () =>
      group.entries.some((entry) =>
        entry.blocks.some((block) => {
          if (block.type !== 'tool_use') {
            return false;
          }

          const toolMeta = block.toolCallId ? toolCallIndex.get(block.toolCallId) : undefined;
          const toolUiState = block.toolCallId ? mergedToolState.toolCallUiStateIndex.get(block.toolCallId) ?? null : null;
          const hasResult = toolUiState?.hasResult ?? Boolean(toolMeta?.resultBlock);
          if (hasResult) {
            return false;
          }

          if (toolUiState?.interrupted) {
            return false;
          }

          return Boolean(toolUiState?.terminalApproval);
        })
      ),
    [group.entries, mergedToolState.toolCallUiStateIndex, toolCallIndex]
  );
  const shouldDefaultExpand = hasPendingApproval || group.status === 'streaming';
  const [expanded, setExpanded] = useState(shouldDefaultExpand);
  const countLabel = `${group.entries.length}项`;

  useEffect(() => {
    if (shouldDefaultExpand) {
      setExpanded(true);
      return;
    }

    if (group.status === 'complete') {
      setExpanded(false);
    }
  }, [group.status, shouldDefaultExpand]);

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        disabled={hasPendingApproval}
        className={`w-full px-3.5 py-2.5 text-left transition ${
          hasPendingApproval ? 'cursor-default bg-amber-50/50' : `hover:bg-zinc-50/80 ${expanded ? 'bg-zinc-50/70' : ''}`
        }`}
        onClick={() => {
          if (!hasPendingApproval) {
            setExpanded((current) => !current);
          }
        }}
      >
        <div className="flex items-start gap-2.5">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center pt-0.5">
            <ToolStatusIcon status={group.status} />
          </div>
          <div className="min-w-0 flex-1 whitespace-normal break-words text-sm font-medium leading-5 text-zinc-900">
            {group.title}
          </div>
          <span
            className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium tabular-nums text-zinc-500"
          >
            {countLabel}
          </span>
          {hasPendingApproval ? (
            <span
              className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-medium tabular-nums text-amber-900"
            >
              审批中
            </span>
          ) : null}
          <span className="mt-0.5 shrink-0 text-zinc-500">
            {hasPendingApproval ? (
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M4 8h8" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-4 w-4 transition ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="m4.5 6.5 3.5 3 3.5-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-zinc-200 px-3.5 py-3">
          <div className="divide-y divide-zinc-200">
            {group.entries.map((entry) => (
              <div key={entry.id} className="py-3 first:pt-0 last:pb-0">
                <MessageContent
                  canSendApprovalInput={canSendApprovalInput}
                  message={entry}
                  mergedToolState={mergedToolState}
                  onApprovalInput={onApprovalInput}
                  toolCallIndex={toolCallIndex}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ChatPane({
  activeProviderId,
  canSendApprovalInput = false,
  conversationScrollKey,
  connected,
  frameSnapshot = null,
  messages,
  onMobileJumpControlsChange,
  onApprovalInput,
  onRespondRuntimeRequest,
  paneVisible,
  runtimeRequests = [],
  scrollToBottomRequestKey,
  transientNotice = null,
  visible
}: ChatPaneProps) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const pendingFollowScrollRef = useRef(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [hasPendingNewContent, setHasPendingNewContent] = useState(false);
  const previousContentSignatureRef = useRef<string | null>(null);
  const previousLatestRenderableMessageSignatureRef = useRef<string | null>(null);
  const previousConversationScrollKeyRef = useRef<string | null>(null);
  const previousScrollToBottomRequestKeyRef = useRef(scrollToBottomRequestKey);
  const reconnectMessagesScrollRef = useRef<{
    conversationScrollKey: string | null;
    scrollHeight: number;
    scrollTop: number;
    wasFollowingLatest: boolean;
  } | null>(null);
  const questionJumpPressTimeoutRef = useRef<number | null>(null);
  const questionJumpLongPressTriggeredRef = useRef(false);
  const questionMessageRefs = useRef(new Map<string, HTMLDivElement>());
  const touchScrollStartYRef = useRef<number | null>(null);
  const userScrollIntentUntilRef = useRef(0);

  const renderableMessages = useMemo(() => messages.filter((message) => hasRenderableMessageContent(message)), [messages]);
  const displayItems = useMemo<ChatPaneDisplayItem[]>(
    () =>
      // Keep Codex tool activity as stable message entries instead of regrouping
      // them into synthetic cards during streaming. Regrouping changes React keys
      // mid-turn and makes the UI look like cards are being replaced.
      renderableMessages.map((message) => ({ type: 'message' as const, message })),
    [activeProviderId, renderableMessages]
  );
  // Tool results can arrive as standalone user messages in Claude transcripts.
  // Keep them out of the main message list, but still index them so tool cards
  // reflect the actual completion/error state.
  const toolCallIndex = useMemo(() => createToolCallIndex(messages), [messages]);
  const latestOpenToolCallId = useMemo(() => findLatestOpenToolCallId(messages, toolCallIndex), [messages, toolCallIndex]);
  const terminalSideChannel = useMemo(
    () => detectTerminalSideChannelState(frameSnapshot, latestOpenToolCallId),
    [frameSnapshot, latestOpenToolCallId]
  );
  const mergedToolState = useMemo(
    () => mergeToolCallUiState(messages, toolCallIndex, terminalSideChannel),
    [messages, terminalSideChannel, toolCallIndex]
  );
  const latestRenderableMessage = renderableMessages.at(-1) ?? null;
  const latestRenderableMessageSignature = latestRenderableMessage
    ? createMessageRenderSignature(latestRenderableMessage)
    : null;
  const contentSignature = useMemo(
    () =>
      [
        conversationScrollKey ?? '',
        renderableMessages.length,
        latestRenderableMessageSignature ?? '',
        transientNotice?.message ?? '',
        transientNotice?.details ?? '',
        runtimeRequests.map((request) => `${request.method}:${request.requestId}`).join('|'),
        mergedToolState.approvalNotice?.title ?? '',
        mergedToolState.interruptedNotice?.message ?? ''
      ].join('::'),
    [
      conversationScrollKey,
      latestRenderableMessageSignature,
      transientNotice?.details,
      transientNotice?.message,
      mergedToolState.approvalNotice?.title,
      mergedToolState.interruptedNotice?.message,
      renderableMessages.length,
      runtimeRequests
    ]
  );
  const questionMessageIds = useMemo(
    () =>
      displayItems
        .flatMap((item) => (item.type === 'message' && item.message.role === 'user' ? [item.message.id] : [])),
    [displayItems]
  );

  function setFollowingLatestState(next: boolean): void {
    setIsFollowingLatest((current) => (current === next ? current : next));
    if (next) {
      setHasPendingNewContent(false);
    }
  }

  function markUserScrollIntent(durationMs = USER_SCROLL_INTENT_WINDOW_MS): void {
    userScrollIntentUntilRef.current = Date.now() + durationMs;
  }

  function hasRecentUserScrollIntent(): boolean {
    return Date.now() <= userScrollIntentUntilRef.current;
  }

  useEffect(() => {
    if (!onMobileJumpControlsChange) {
      return;
    }

    if (!visible) {
      onMobileJumpControlsChange(null);
      return;
    }

    onMobileJumpControlsChange({
      canJumpUp: questionMessageIds.length > 0,
      canJumpDown: questionMessageIds.length > 0,
      upLabel: '跳到上一条提问，长按直达顶部',
      downLabel: '跳到下一条提问，长按直达底部',
      onJumpUp: () => handleJumpToQuestion('up'),
      onJumpDown: () => handleJumpToQuestion('down'),
      onJumpUpLongPress: () => handleJumpToMessagesEdge('up'),
      onJumpDownLongPress: () => handleJumpToMessagesEdge('down')
    });

    return () => {
      onMobileJumpControlsChange(null);
    };
  }, [onMobileJumpControlsChange, questionMessageIds.length, visible, conversationScrollKey, renderableMessages.length]);
  useEffect(() => {
    return () => {
      if (questionJumpPressTimeoutRef.current !== null) {
        window.clearTimeout(questionJumpPressTimeoutRef.current);
      }
    };
  }, []);

  function scrollMessagesToBottom(options?: ScrollIntoViewOptions): void {
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) {
      return;
    }

    pendingFollowScrollRef.current = true;
    setFollowingLatestState(true);
    sentinel.scrollIntoView({
      block: 'end',
      inline: 'nearest',
      behavior: options?.behavior ?? 'auto'
    });
  }

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    if (!connected) {
      if (renderableMessages.length === 0) {
        return;
      }
      reconnectMessagesScrollRef.current = {
        conversationScrollKey,
        scrollHeight: messagesElement.scrollHeight,
        scrollTop: messagesElement.scrollTop,
        wasFollowingLatest: isFollowingLatest
      };
      return;
    }

    if (
      reconnectMessagesScrollRef.current &&
      reconnectMessagesScrollRef.current.conversationScrollKey !== conversationScrollKey
    ) {
      reconnectMessagesScrollRef.current = null;
    }
  }, [connected, conversationScrollKey, isFollowingLatest, renderableMessages.length]);

  useEffect(() => {
    if (previousScrollToBottomRequestKeyRef.current === scrollToBottomRequestKey) {
      return;
    }
    previousScrollToBottomRequestKeyRef.current = scrollToBottomRequestKey;

    if (!paneVisible) {
      return;
    }

    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    scrollMessagesToBottom();
  }, [paneVisible, scrollToBottomRequestKey]);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!messagesElement || !sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          return;
        }

        pendingFollowScrollRef.current = false;
        setFollowingLatestState(true);
      },
      {
        root: messagesElement,
        threshold: 1
      }
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [conversationScrollKey]);

  useEffect(() => {
    const contentElement = messagesContentRef.current;
    if (!contentElement) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!paneVisible || !isFollowingLatest) {
        return;
      }
      scrollMessagesToBottom();
    });

    observer.observe(contentElement);
    return () => {
      observer.disconnect();
    };
  }, [conversationScrollKey, isFollowingLatest, paneVisible]);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    const hasNewUserMessage =
      latestRenderableMessage?.role === 'user' &&
      previousLatestRenderableMessageSignatureRef.current !== latestRenderableMessageSignature;
    previousLatestRenderableMessageSignatureRef.current = latestRenderableMessageSignature;
    const hasContentChanged = previousContentSignatureRef.current !== contentSignature;
    previousContentSignatureRef.current = contentSignature;

    const reconnectScroll = reconnectMessagesScrollRef.current;
    if (connected && reconnectScroll && reconnectScroll.conversationScrollKey === conversationScrollKey && renderableMessages.length > 0) {
      messagesElement.scrollTop = reconnectScroll.scrollTop + (messagesElement.scrollHeight - reconnectScroll.scrollHeight);
      reconnectMessagesScrollRef.current = null;
      if (reconnectScroll.wasFollowingLatest) {
        scrollMessagesToBottom();
        return;
      }
      setFollowingLatestState(isScrolledToBottom(messagesElement));
      return;
    }

    const isConversationChanged = previousConversationScrollKeyRef.current !== conversationScrollKey;
    previousConversationScrollKeyRef.current = conversationScrollKey;

    if (isConversationChanged) {
      pendingFollowScrollRef.current = false;
      setFollowingLatestState(true);
      scrollMessagesToBottom();
      return;
    }

    if (hasContentChanged && ((hasNewUserMessage && paneVisible) || isFollowingLatest)) {
      scrollMessagesToBottom();
      return;
    }

    if (hasContentChanged && paneVisible) {
      setHasPendingNewContent(true);
    }
  }, [connected, contentSignature, conversationScrollKey, isFollowingLatest, latestRenderableMessage, latestRenderableMessageSignature, paneVisible, renderableMessages.length]);

  function setQuestionMessageRef(messageId: string, node: HTMLDivElement | null): void {
    if (node) {
      questionMessageRefs.current.set(messageId, node);
      return;
    }
    questionMessageRefs.current.delete(messageId);
  }

  function handleJumpToQuestion(direction: 'up' | 'down'): void {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const questionAnchors = questionMessageIds
      .map((messageId) => {
        const node = questionMessageRefs.current.get(messageId);
        return node
          ? {
              messageId,
              node,
              top: node.getBoundingClientRect().top - containerRect.top + container.scrollTop
            }
          : null;
      })
      .filter(Boolean) as Array<{ messageId: string; node: HTMLDivElement; top: number }>;

    if (questionAnchors.length === 0) {
      return;
    }

    setFollowingLatestState(false);

    const currentTop = container.scrollTop;
    const currentIndex = questionAnchors.findLastIndex((anchor) => anchor.top <= currentTop + 24);
    const normalizedCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const currentAnchor = questionAnchors[normalizedCurrentIndex];
    const isAwayFromCurrentQuestionTop = currentAnchor ? currentTop > currentAnchor.top + 24 : false;
    const targetIndex =
      direction === 'up'
        ? isAwayFromCurrentQuestionTop
          ? normalizedCurrentIndex
          : Math.max(0, normalizedCurrentIndex - 1)
        : Math.min(questionAnchors.length - 1, normalizedCurrentIndex + 1);
    const target = questionAnchors[targetIndex];

    target.node.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function handleMessagesScroll(event: React.UIEvent<HTMLDivElement>): void {
    if (pendingFollowScrollRef.current) {
      return;
    }

    if (isScrolledToBottom(event.currentTarget)) {
      setFollowingLatestState(true);
      return;
    }

    if (hasRecentUserScrollIntent()) {
      setFollowingLatestState(false);
    }
  }

  function handleMessagesWheel(): void {
    markUserScrollIntent();
  }

  function handleMessagesPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    markUserScrollIntent();
  }

  function handleMessagesTouchStart(event: React.TouchEvent<HTMLDivElement>): void {
    const touch = event.touches[0];
    touchScrollStartYRef.current = touch ? touch.clientY : null;
  }

  function handleMessagesTouchMove(event: React.TouchEvent<HTMLDivElement>): void {
    const touch = event.touches[0];
    const startY = touchScrollStartYRef.current;
    if (!touch || startY === null) {
      return;
    }
    if (Math.abs(touch.clientY - startY) >= TOUCH_SCROLL_INTENT_DELTA_PX) {
      markUserScrollIntent();
    }
  }

  function handleMessagesTouchEnd(): void {
    touchScrollStartYRef.current = null;
  }

  function handleJumpToMessagesEdge(direction: 'up' | 'down'): void {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    if (direction === 'up') {
      setFollowingLatestState(false);
      container.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
      return;
    }

    scrollMessagesToBottom({ behavior: 'smooth' });
  }

  function handleJumpToLatest(): void {
    scrollMessagesToBottom({ behavior: 'smooth' });
  }

  function clearQuestionJumpPressTimeout(): void {
    if (questionJumpPressTimeoutRef.current !== null) {
      window.clearTimeout(questionJumpPressTimeoutRef.current);
      questionJumpPressTimeoutRef.current = null;
    }
  }

  function handleQuestionJumpButtonPressStart(direction: 'up' | 'down', event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    clearQuestionJumpPressTimeout();
    questionJumpLongPressTriggeredRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    questionJumpPressTimeoutRef.current = window.setTimeout(() => {
      questionJumpPressTimeoutRef.current = null;
      questionJumpLongPressTriggeredRef.current = true;
      handleJumpToMessagesEdge(direction);
    }, QUESTION_JUMP_LONG_PRESS_DELAY_MS);
  }

  function handleQuestionJumpButtonPressEnd(direction: 'up' | 'down', event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    clearQuestionJumpPressTimeout();

    if (questionJumpLongPressTriggeredRef.current) {
      questionJumpLongPressTriggeredRef.current = false;
      return;
    }

    handleJumpToQuestion(direction);
  }

  function handleQuestionJumpButtonPressCancel(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    clearQuestionJumpPressTimeout();
    questionJumpLongPressTriggeredRef.current = false;
  }

  function handleQuestionJumpButtonKeyboardClick(direction: 'up' | 'down', event: React.MouseEvent<HTMLButtonElement>): void {
    if (event.detail !== 0) {
      return;
    }

    handleJumpToQuestion(direction);
  }

  return (
    <div
      className={[
        'min-h-0 min-w-0 flex-1 flex-col',
        visible ? 'flex' : 'hidden lg:flex'
      ].join(' ')}
    >
      <div className="relative flex min-h-[22rem] min-w-0 flex-1 flex-col overflow-hidden bg-transparent sm:min-h-[24rem] lg:min-h-[28rem] lg:rounded-3xl lg:border lg:border-zinc-200 lg:bg-white lg:shadow-sm">
        <div className="hidden px-3 py-3 sm:px-4 lg:block lg:border-b lg:border-zinc-200">
          <div>
            <h2 className="text-lg font-semibold">Messages</h2>
          </div>
        </div>
        <div
          ref={messagesRef}
          onScroll={handleMessagesScroll}
          onWheelCapture={handleMessagesWheel}
          onPointerDownCapture={handleMessagesPointerDown}
          onTouchEndCapture={handleMessagesTouchEnd}
          onTouchMoveCapture={handleMessagesTouchMove}
          onTouchStartCapture={handleMessagesTouchStart}
          className="min-h-0 min-w-0 flex-1 overflow-auto px-3 pt-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] sm:px-3 lg:px-4 lg:py-4"
        >
          <div ref={messagesContentRef} className="space-y-2">
            {runtimeRequests.map((request) => (
              <RuntimeRequestNotice
                key={`${request.method}:${request.requestId}`}
                canRespond={connected}
                onRespond={onRespondRuntimeRequest}
                request={request}
              />
            ))}
            {mergedToolState.interruptedNotice ? <TerminalInterruptedBanner interrupted={mergedToolState.interruptedNotice} /> : null}
            {mergedToolState.approvalNotice ? (
              <TerminalApprovalInlineNotice
                approval={mergedToolState.approvalNotice}
                canSendApprovalInput={canSendApprovalInput && connected}
                onApprovalInput={onApprovalInput}
              />
            ) : null}
            {displayItems.length === 0
              ? null
              : displayItems.map((item) => {
                  if (item.type === 'activity_group') {
                    return (
                      <ActivityGroupCard
                        key={item.group.id}
                        canSendApprovalInput={canSendApprovalInput && connected}
                        group={item.group}
                        mergedToolState={mergedToolState}
                        onApprovalInput={onApprovalInput}
                        toolCallIndex={toolCallIndex}
                      />
                    );
                  }

                  const { message } = item;
                  return (
                    <div
                      key={message.id}
                      ref={message.role === 'user' ? (node) => setQuestionMessageRef(message.id, node) : undefined}
                    >
                      <MessageShell message={message}>
                        <MessageContent
                          canSendApprovalInput={canSendApprovalInput && connected}
                          message={message}
                          mergedToolState={mergedToolState}
                          onApprovalInput={onApprovalInput}
                          toolCallIndex={toolCallIndex}
                        />
                      </MessageShell>
                    </div>
                  );
                })}
            {transientNotice ? <RuntimeTransientNoticeBanner notice={transientNotice} /> : null}
            <div ref={bottomSentinelRef} aria-hidden="true" className="h-px w-full" />
          </div>
        </div>

        {!isFollowingLatest && hasPendingNewContent ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4 md:bottom-16">
            <button
              type="button"
              onClick={handleJumpToLatest}
              className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-900 shadow-[0_10px_24px_rgba(14,165,233,0.18)] transition hover:border-sky-300 hover:bg-sky-100"
            >
              <span>有新内容</span>
              <span className="text-sky-500">·</span>
              <span>跳到最新</span>
            </button>
          </div>
        ) : null}

        {questionMessageIds.length > 0 ? (
          <div className="pointer-events-none absolute right-3 bottom-14 z-10 hidden lg:block md:right-4 md:bottom-16">
            <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-zinc-200/80 bg-white/65 shadow-[0_8px_20px_rgba(0,0,0,0.08)] backdrop-blur-sm">
              <button
                type="button"
                onClick={(event) => handleQuestionJumpButtonKeyboardClick('up', event)}
                onPointerDown={(event) => handleQuestionJumpButtonPressStart('up', event)}
                onPointerUp={(event) => handleQuestionJumpButtonPressEnd('up', event)}
                onPointerCancel={handleQuestionJumpButtonPressCancel}
                className="touch-manipulation select-none flex h-8 w-8 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900 md:h-9 md:w-9"
                aria-label="跳到上一条提问，长按直达顶部"
                title="跳到上一条提问，长按直达顶部"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
                  <path d="M5 12l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="h-px bg-zinc-200/80" />
              <button
                type="button"
                onClick={(event) => handleQuestionJumpButtonKeyboardClick('down', event)}
                onPointerDown={(event) => handleQuestionJumpButtonPressStart('down', event)}
                onPointerUp={(event) => handleQuestionJumpButtonPressEnd('down', event)}
                onPointerCancel={handleQuestionJumpButtonPressCancel}
                className="touch-manipulation select-none flex h-8 w-8 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900 md:h-9 md:w-9"
                aria-label="跳到下一条提问，长按直达底部"
                title="跳到下一条提问，长按直达底部"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
                  <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isScrolledToBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= SCROLL_BOTTOM_THRESHOLD_PX;
}

function createMessageRenderSignature(message: ChatMessage): string {
  const attachmentsSignature = (message.attachments ?? [])
    .map((attachment) => `${attachment.attachmentId}:${attachment.filename}:${attachment.size}`)
    .join('|');
  const blocksSignature = message.blocks
    .map((block) => {
      if (block.type === 'text') {
        return `text:${block.text}`;
      }
      if (block.type === 'tool_use') {
        return `tool_use:${block.toolCallId ?? ''}:${block.toolName}:${block.input}`;
      }
      return `tool_result:${block.toolCallId ?? ''}:${block.isError ? '1' : '0'}:${block.content}`;
    })
    .join('|');

  return `${message.id}|${message.role}|${attachmentsSignature}|${blocksSignature}`;
}
