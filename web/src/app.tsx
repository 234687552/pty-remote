import { Children, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Mermaid as MermaidApi } from 'mermaid';

import type {
  CliCommandName,
  CliCommandPayloadMap,
  CliCommandResult,
  CliStatusPayload,
  MessagesUpdatePayload,
  RawJsonlUpdatePayload,
  TerminalChunkPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@shared/protocol.ts';
import type {
  ChatMessage,
  ChatMessageBlock,
  CliDescriptor,
  MessageStatus,
  RuntimeSnapshot,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '@shared/runtime-types.ts';

function createEmptySnapshot(): RuntimeSnapshot {
  return {
    busy: false,
    sessionId: null,
    terminalReplay: '',
    rawJsonl: '',
    messages: [],
    lastError: null
  };
}

function getSocketBaseUrl(): string {
  const envValue = import.meta.env.VITE_SOCKET_URL;
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  return window.location.origin;
}

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

let mermaidRenderSequence = 0;
let mermaidLoader: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid')
      .then(({ default: mermaidApi }) => {
        mermaidApi.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
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

function getMarkdownNodeText(node: MarkdownNode | undefined): string {
  if (!node) {
    return '';
  }

  if (typeof node.value === 'string') {
    return node.value;
  }

  return node.children?.map((child) => getMarkdownNodeText(child)).join('') ?? '';
}

function getMermaidDefinition(node: MarkdownNode | undefined): string | null {
  const codeNode = node?.children?.find((child) => child.tagName === 'code');
  if (!codeNode) {
    return null;
  }

  const language = getMarkdownCodeLanguage(normalizeClassName(codeNode.properties?.className));
  if (language !== 'mermaid') {
    return null;
  }

  return getMarkdownNodeText(codeNode).trimEnd();
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

function MermaidDiagram({ definition }: { definition: string }) {
  const inlineContainerRef = useRef<HTMLDivElement | null>(null);
  const expandedContainerRef = useRef<HTMLDivElement | null>(null);
  const expandedViewportRef = useRef<HTMLDivElement | null>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    scrollLeft: number;
    scrollTop: number;
    startX: number;
    startY: number;
  } | null>(null);
  const [svg, setSvg] = useState('');
  const [svgDimensions, setSvgDimensions] = useState<SvgDimensions | null>(null);
  const [error, setError] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDraggingExpanded, setIsDraggingExpanded] = useState(false);

  const expandedScale = 1.6;

  useEffect(() => {
    let cancelled = false;
    let frameId = 0;

    if (!definition.trim()) {
      setSvg('');
      setSvgDimensions(null);
      setError('Diagram is empty.');
      return () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    setSvg('');
    setError('');

    const renderDiagram = async () => {
      try {
        const mermaidApi = await loadMermaid();
        const renderId = `mermaid-diagram-${++mermaidRenderSequence}`;
        const { svg: nextSvg, bindFunctions } = await mermaidApi.render(renderId, definition);
        if (cancelled) {
          return;
        }

        setSvg(nextSvg);
        setSvgDimensions(getSvgDimensions(nextSvg));
        bindFunctionsRef.current = bindFunctions ?? null;
        frameId = window.requestAnimationFrame(() => {
          if (!cancelled && bindFunctions && inlineContainerRef.current) {
            bindFunctions(inlineContainerRef.current);
          }
        });
      } catch (renderError) {
        if (cancelled) {
          return;
        }

        setSvg('');
        setSvgDimensions(null);
        bindFunctionsRef.current = null;
        setError(renderError instanceof Error ? renderError.message : 'Mermaid could not render this diagram.');
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
      setIsDraggingExpanded(false);
      dragStateRef.current = null;
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

  useEffect(() => {
    if (!isExpanded || !bindFunctionsRef.current || !expandedContainerRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (expandedContainerRef.current && bindFunctionsRef.current) {
        bindFunctionsRef.current(expandedContainerRef.current);
      }

      const svgElement = expandedContainerRef.current?.querySelector('svg');
      if (svgElement && svgDimensions) {
        svgElement.setAttribute('width', String(svgDimensions.width * expandedScale));
        svgElement.setAttribute('height', String(svgDimensions.height * expandedScale));
        svgElement.style.width = `${svgDimensions.width * expandedScale}px`;
        svgElement.style.height = `${svgDimensions.height * expandedScale}px`;
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [expandedScale, isExpanded, svg, svgDimensions]);

  const endExpandedDrag = (pointerId?: number) => {
    const viewport = expandedViewportRef.current;
    if (viewport && pointerId !== undefined && viewport.hasPointerCapture(pointerId)) {
      viewport.releasePointerCapture(pointerId);
    }
    dragStateRef.current = null;
    setIsDraggingExpanded(false);
  };

  const handleExpandedPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !expandedViewportRef.current) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      scrollLeft: expandedViewportRef.current.scrollLeft,
      scrollTop: expandedViewportRef.current.scrollTop,
      startX: event.clientX,
      startY: event.clientY
    };
    expandedViewportRef.current.setPointerCapture(event.pointerId);
    setIsDraggingExpanded(true);
  };

  const handleExpandedPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    const viewport = expandedViewportRef.current;
    if (!dragState || !viewport || dragState.pointerId !== event.pointerId) {
      return;
    }

    viewport.scrollLeft = dragState.scrollLeft - (event.clientX - dragState.startX);
    viewport.scrollTop = dragState.scrollTop - (event.clientY - dragState.startY);
  };

  const handleExpandedPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      endExpandedDrag(event.pointerId);
    }
  };

  const handleExpandedPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      endExpandedDrag(event.pointerId);
    }
  };

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
            <button
              type="button"
              aria-label="Expand Mermaid diagram"
              className="absolute top-2 right-2 z-10 inline-flex h-8 items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-2.5 text-[11px] font-medium text-zinc-700 shadow-sm transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 hover:border-zinc-300 hover:text-zinc-950 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60"
              onClick={() => setIsExpanded(true)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M6 3.5H3.5V6M10 3.5h2.5V6M6 12.5H3.5V10M10 12.5h2.5V10" strokeLinecap="round" />
                <path d="M3.5 6 6.8 2.7M12.5 6 9.2 2.7M3.5 10l3.3 3.3M12.5 10l-3.3 3.3" strokeLinecap="round" />
              </svg>
              <span>Zoom</span>
            </button>
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
          className="fixed inset-0 z-50 bg-zinc-950/70 px-4 py-5 backdrop-blur-sm sm:px-6 sm:py-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsExpanded(false);
            }
          }}
        >
          <div className="mx-auto flex h-full max-w-7xl flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-zinc-950">Mermaid diagram</div>
                <div className="text-xs text-zinc-500">Drag to pan. Press Escape to close.</div>
              </div>
              <button
                type="button"
                className="inline-flex h-9 items-center rounded-full border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition hover:border-zinc-300 hover:text-zinc-950"
                onClick={() => setIsExpanded(false)}
              >
                Close
              </button>
            </div>
            <div
              ref={expandedViewportRef}
              className={`relative flex-1 overflow-auto bg-zinc-100/80 p-6 touch-none ${isDraggingExpanded ? 'cursor-grabbing' : 'cursor-grab'}`}
              onPointerDown={handleExpandedPointerDown}
              onPointerMove={handleExpandedPointerMove}
              onPointerUp={handleExpandedPointerUp}
              onPointerCancel={handleExpandedPointerCancel}
            >
              <div className="flex min-h-full min-w-full items-start justify-center">
                <div
                  ref={expandedContainerRef}
                  className="inline-block rounded-xl border border-zinc-200 bg-white shadow-lg [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none"
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

function MessageMarkdown({ content, tone = 'default' }: { content: string; tone?: 'default' | 'inverse' }) {
  const isInverse = tone === 'inverse';

  return (
    <div className={`markdown-body space-y-3 leading-6 ${isInverse ? 'text-zinc-100' : 'text-zinc-800'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a
              {...props}
              className={isInverse ? 'text-zinc-100 underline underline-offset-2' : 'text-blue-700 underline underline-offset-2'}
              target="_blank"
              rel="noreferrer"
            />
          ),
          blockquote: ({ ...props }) => (
            <blockquote
              {...props}
              className={isInverse ? 'border-l-2 border-zinc-600 pl-4 text-zinc-300' : 'border-l-2 border-zinc-300 pl-4 text-zinc-600'}
            />
          ),
          code: ({ children, className, ...props }) => {
            const codeContent = getMarkdownTextContent(children);
            const isBlock = Boolean(className) || codeContent.includes('\n');
            if (isBlock) {
              const codeClassName = [
                className,
                isInverse
                  ? 'block overflow-x-auto rounded-xl bg-zinc-950/90 px-4 py-3 text-xs leading-5 text-zinc-100'
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
                    ? 'rounded bg-white/15 px-1.5 py-0.5 text-[0.85em] text-zinc-100'
                    : 'rounded bg-zinc-200 px-1.5 py-0.5 text-[0.85em] text-zinc-900'
                }
              >
                {children}
              </code>
            );
          },
          h1: ({ ...props }) => <h1 {...props} className={isInverse ? 'text-lg font-semibold text-white' : 'text-lg font-semibold text-zinc-950'} />,
          h2: ({ ...props }) => <h2 {...props} className={isInverse ? 'text-base font-semibold text-white' : 'text-base font-semibold text-zinc-950'} />,
          h3: ({ ...props }) => <h3 {...props} className={isInverse ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-zinc-950'} />,
          li: ({ ...props }) => <li {...props} className="ml-5 list-item" />,
          ol: ({ ...props }) => <ol {...props} className="list-decimal space-y-1 pl-5" />,
          p: ({ ...props }) => <p {...props} className="whitespace-pre-wrap break-words" />,
          pre: ({ children, node, ...props }) => {
            const mermaidDefinition = getMermaidDefinition(node as MarkdownNode | undefined);
            if (mermaidDefinition) {
              return <MermaidDiagram definition={mermaidDefinition} />;
            }

            return (
              <pre
                {...props}
                className={
                  isInverse
                    ? 'overflow-x-auto rounded-xl bg-zinc-950'
                    : 'overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-100'
                }
              >
                {children}
              </pre>
            );
          },
          ul: ({ ...props }) => <ul {...props} className="list-disc space-y-1 pl-5" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

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

type ToolVariantTone = 'generic' | 'shell' | 'web' | 'mcp';
type ToolIconKind = 'generic' | 'network' | 'command' | 'tool';

function getToolVariant(toolName: string | undefined): { iconKind: ToolIconKind; tone: ToolVariantTone } {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { iconKind: 'generic', tone: 'generic' };
  }

  if (lower.includes('bash') || lower.includes('shell') || lower.includes('terminal')) {
    return { iconKind: 'command', tone: 'shell' };
  }

  if (lower.includes('websearch') || lower.includes('fetch') || lower.startsWith('web')) {
    return { iconKind: 'network', tone: 'web' };
  }

  if (lower.startsWith('mcp__')) {
    return { iconKind: 'tool', tone: 'mcp' };
  }

  return {
    iconKind: 'generic',
    tone: 'generic'
  };
}

function ToolBadgeIcon({ kind }: { kind: ToolIconKind }) {
  switch (kind) {
    case 'network':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M3 6.2a7.6 7.6 0 0 1 10 0" strokeLinecap="round" />
          <path d="M5.3 8.6a4.6 4.6 0 0 1 5.4 0" strokeLinecap="round" />
          <path d="M7.2 11a1.7 1.7 0 0 1 1.6 0" strokeLinecap="round" />
          <circle cx="8" cy="12.9" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'command':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="m3.5 4.5 3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.5 10.5h4" strokeLinecap="round" />
        </svg>
      );
    case 'tool':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path
            d="M9.8 2.7a3 3 0 0 0 3.4 3.5l-2 2-1.8-1.8-4.8 4.8a1.2 1.2 0 1 0 1.7 1.7l4.8-4.8 1.8 1.8 2-2a3 3 0 0 0-3.5-3.4Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'generic':
    default:
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="3" y="3" width="10" height="10" rx="2" />
          <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" strokeLinecap="round" />
        </svg>
      );
  }
}

function getCompactToolTitle(toolName: string | undefined): string {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return 'Tool';
  }

  if (lower.includes('bash') || lower.includes('shell') || lower.includes('terminal')) {
    return 'Shell';
  }

  if (lower.startsWith('web')) {
    return normalized.split(/[.:/]/).at(-1) || 'Web';
  }

  if (lower.startsWith('mcp__')) {
    return normalized.split('__').at(-1) || 'MCP';
  }

  return normalized.split(/[.:/]/).at(-1) || normalized;
}

function getToolToneClasses(_tone: ToolVariantTone): {
  badge: string;
  surface: string;
  border: string;
  title: string;
  meta: string;
} {
  return {
    badge: 'border border-zinc-300 bg-white text-zinc-950',
    surface: 'bg-white',
    border: 'border-zinc-200',
    title: 'text-zinc-900',
    meta: 'text-zinc-500'
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
      <span className="absolute inline-flex h-3 w-3 rounded-full bg-emerald-600/30 animate-ping" />
      <span className="relative inline-block h-2 w-2 rounded-full bg-emerald-600" />
    </span>
  );
}

function ToolDetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      {children}
    </section>
  );
}

function hasNonTextBlock(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type !== 'text');
}

function MessageShell({ message, children }: { message: ChatMessage; children: React.ReactNode }) {
  if (hasNonTextBlock(message)) {
    return <>{children}</>;
  }

  const wrapperClass = message.role === 'user' ? 'flex justify-end' : 'flex justify-start';
  const shellClass = [
    'w-fit max-w-[85%] px-3.5 py-2.5 text-sm break-words',
    message.role === 'user'
      ? 'rounded-2xl bg-zinc-900 text-white shadow-sm'
      : message.status === 'error'
        ? 'rounded-2xl border border-red-200 bg-red-50 text-zinc-900 shadow-sm'
        : 'text-zinc-900'
  ].join(' ');

  return (
    <div className={wrapperClass}>
      <article className={shellClass}>{children}</article>
    </div>
  );
}

interface ToolCallMeta {
  toolName?: string;
  useBlockId?: string;
  resultBlock?: ToolResultChatMessageBlock;
  resultStatus?: MessageStatus;
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

function TextBlockContent({
  block,
  isStreaming,
  tone
}: {
  block: Extract<ChatMessageBlock, { type: 'text' }>;
  isStreaming: boolean;
  tone?: 'default' | 'inverse';
}) {
  const content = isStreaming ? `${block.text}\n\n...` : block.text;
  return <MessageMarkdown content={content} tone={tone} />;
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

function ToolUseBlockContent({
  block,
  status,
  resultBlock
}: {
  block: ToolUseChatMessageBlock;
  status: MessageStatus;
  resultBlock?: ToolResultChatMessageBlock;
}) {
  const variant = getToolVariant(block.toolName);
  const compactTitle = getCompactToolTitle(block.toolName);
  const toneClasses = getToolToneClasses(variant.tone);
  const summaryPreview = getToolInputPreview(block.input, 112);

  return (
    <div className="flex justify-start">
      <details className={`group w-full overflow-hidden rounded-lg border ${toneClasses.border} ${toneClasses.surface} shadow-sm`}>
        <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                <ToolStatusIcon status={status} />
              </div>
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[8px] font-semibold ${toneClasses.badge}`}
              >
                <ToolBadgeIcon kind={variant.iconKind} />
              </div>
              <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                <div className={`shrink-0 text-[11px] font-medium ${toneClasses.title}`}>{compactTitle}</div>
                <div className={`min-w-0 flex-1 truncate font-mono text-[11px] ${toneClasses.meta}`}>{summaryPreview || '(no input)'}</div>
              </div>
            </div>
            <span className="shrink-0 text-[15px] font-semibold leading-none text-zinc-700 transition-transform group-open:rotate-180">
              ▾
            </span>
          </div>
        </summary>
        <div className={`space-y-3 border-t px-3 py-3 ${toneClasses.border}`}>
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
      </details>
    </div>
  );
}

function hasRenderableMessageContent(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type !== 'tool_result');
}

function MessageContent({ message, toolCallIndex }: { message: ChatMessage; toolCallIndex: Map<string, ToolCallMeta> }) {
  if (message.blocks.length === 0) {
    return <MessageMarkdown content={message.status === 'streaming' ? '...' : ''} />;
  }

  return (
    <div className="space-y-2">
      {message.blocks.map((block, index) => {
        if (block.type === 'text') {
          const isLastBlock = index === message.blocks.length - 1;
          return (
            <TextBlockContent
              key={block.id}
              block={block}
              isStreaming={message.status === 'streaming' && isLastBlock}
              tone={message.role === 'user' ? 'inverse' : 'default'}
            />
          );
        }

        if (block.type === 'tool_use') {
          const toolMeta = block.toolCallId ? toolCallIndex.get(block.toolCallId) : undefined;
          return (
            <ToolUseBlockContent
              key={block.id}
              block={block}
              status={resolveToolUseStatus(block, toolCallIndex, message.status)}
              resultBlock={toolMeta?.resultBlock}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

export function App() {
  const [socketConnected, setSocketConnected] = useState(false);
  const [cli, setCli] = useState<CliDescriptor | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(createEmptySnapshot());
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');

  const socketRef = useRef<Socket | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const appliedReplayLengthRef = useRef(0);
  const appliedSessionIdRef = useRef<string | null>(null);

  const connected = Boolean(socketConnected && cli?.connected);
  const canCompose = connected && !snapshot.busy;
  const toolCallIndex = useMemo(() => createToolCallIndex(snapshot.messages), [snapshot.messages]);
  const renderableMessages = useMemo(
    () => snapshot.messages.filter((message) => hasRenderableMessageContent(message)),
    [snapshot.messages]
  );

  useEffect(() => {
    if (!terminalHostRef.current || terminalInstanceRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cols: 120,
      rows: 32,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: 'Berkeley Mono, SFMono-Regular, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#f8fafc',
        selectionBackground: 'rgba(148, 163, 184, 0.35)'
      }
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminalInstanceRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(terminalHostRef.current);

    return () => {
      observer.disconnect();
      terminal.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

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
      setError('');
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
    });

    socket.on('web:init', (payload: WebInitPayload) => {
      setCli(payload.cli);
      setSnapshot(payload.snapshot ?? createEmptySnapshot());
    });

    socket.on('cli:update', (payload: CliStatusPayload) => {
      setCli(payload.cli);
    });

    socket.on('messages:update', (payload: MessagesUpdatePayload) => {
      setSnapshot((current) => {
        const sessionChanged = current.sessionId !== payload.sessionId;
        return {
          ...current,
          busy: payload.busy,
          sessionId: payload.sessionId,
          rawJsonl: sessionChanged ? '' : current.rawJsonl,
          messages: payload.messages,
          lastError: payload.lastError,
          terminalReplay: sessionChanged ? '' : current.terminalReplay
        };
      });
    });

    socket.on('raw-jsonl:update', (payload: RawJsonlUpdatePayload) => {
      setSnapshot((current) => {
        const sessionChanged = current.sessionId !== payload.sessionId;
        const currentRawJsonl = sessionChanged ? '' : current.rawJsonl;
        let nextRawJsonl = currentRawJsonl;

        if (payload.reset) {
          nextRawJsonl = payload.chunk;
        } else if (currentRawJsonl.length === payload.baseLength) {
          nextRawJsonl = `${currentRawJsonl}${payload.chunk}`;
        } else {
          nextRawJsonl = `${currentRawJsonl.slice(0, Math.max(0, payload.baseLength))}${payload.chunk}`;
        }

        return {
          ...current,
          sessionId: payload.sessionId,
          rawJsonl: nextRawJsonl
        };
      });
    });

    socket.on('terminal:chunk', (payload: TerminalChunkPayload) => {
      const terminal = terminalInstanceRef.current;
      if (!terminal) {
        return;
      }
      if (!payload.sessionId || payload.sessionId !== appliedSessionIdRef.current) {
        return;
      }

      terminal.write(payload.data);
      appliedReplayLengthRef.current += payload.data.length;
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    const nextReplay = snapshot.terminalReplay || '';
    const sessionChanged = appliedSessionIdRef.current !== snapshot.sessionId;
    const replayRewound = nextReplay.length < appliedReplayLengthRef.current;

    if (sessionChanged || replayRewound) {
      terminal.reset();
      if (nextReplay) {
        terminal.write(nextReplay);
      }
      appliedSessionIdRef.current = snapshot.sessionId;
      appliedReplayLengthRef.current = nextReplay.length;
      fitAddonRef.current?.fit();
      return;
    }

    if (nextReplay.length > appliedReplayLengthRef.current) {
      terminal.write(nextReplay.slice(appliedReplayLengthRef.current));
      appliedReplayLengthRef.current = nextReplay.length;
    }
  }, [snapshot.sessionId, snapshot.terminalReplay]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [renderableMessages]);

  const headerText = useMemo(() => {
    if (!socketConnected) {
      return 'waiting for socket';
    }
    if (!cli?.connected) {
      return 'waiting for cli';
    }
    if (snapshot.busy) {
      return 'running';
    }
    return 'idle';
  }, [cli?.connected, snapshot.busy, socketConnected]);

  async function sendCommand<TName extends CliCommandName>(name: TName, payload: CliCommandPayloadMap[TName]) {
    const socket = socketRef.current;
    if (!socket?.connected) {
      throw new Error('Socket is not connected');
    }

    const result = await new Promise<CliCommandResult>((resolve) => {
      socket.emit('web:command', { name, payload } satisfies WebCommandEnvelope<TName>, (ack?: CliCommandResult) => {
        resolve(ack ?? { ok: false, error: 'No response from server' });
      });
    });

    if (!result.ok) {
      throw new Error(result.error || 'Request failed');
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const content = prompt.trim();
    if (!content) {
      setError('请输入消息');
      return;
    }

    try {
      setError('');
      await sendCommand('send-message', { content });
      setPrompt('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function handleReset() {
    try {
      setError('');
      await sendCommand('reset-session', {});
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : '重置失败');
    }
  }

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 p-4 md:p-6">
        <header className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold">hapi-tmux</h1>
              <p className="text-sm text-zinc-500">raw PTY → xterm，聊天面板来自 Claude jsonl</p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-medium">
              <span className="rounded-full bg-zinc-900 px-3 py-1 text-white">socket: {socketConnected ? 'online' : 'offline'}</span>
              <span className="rounded-full bg-zinc-200 px-3 py-1 text-zinc-800">cli: {cli?.connected ? 'online' : 'offline'}</span>
              <span className="rounded-full bg-zinc-200 px-3 py-1 text-zinc-800">status: {headerText}</span>
              <span className="rounded-full bg-zinc-200 px-3 py-1 text-zinc-800">session: {snapshot.sessionId ?? '-'}</span>
            </div>
          </div>
          <div className="mt-3 grid gap-2 text-sm text-zinc-600 md:grid-cols-2">
            <div>label: {cli?.label ?? '-'}</div>
            <div>cwd: {cli?.cwd ?? '-'}</div>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr,1.2fr]">
          <div className="flex min-h-[28rem] flex-col rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-lg font-semibold">Messages</h2>
            </div>
            <div ref={messagesRef} className="flex-1 space-y-2 overflow-auto px-4 py-4">
              {renderableMessages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                  等待 Claude jsonl 写入会话内容。
                </div>
              ) : (
                renderableMessages.map((message) => (
                  <MessageShell key={message.id} message={message}>
                    <MessageContent message={message} toolCallIndex={toolCallIndex} />
                  </MessageShell>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-[28rem] flex-col rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-lg font-semibold">Terminal</h2>
            </div>
            <div className="terminal-shell flex-1 overflow-hidden rounded-b-3xl bg-slate-950 p-3">
              <div ref={terminalHostRef} className="h-full w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950" />
            </div>
          </div>
        </section>

        <form onSubmit={handleSubmit} className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Composer</h2>
            <button
              type="button"
              onClick={() => {
                void handleReset();
              }}
              className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!connected}
            >
              新会话
            </button>
          </div>

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            placeholder={!connected ? '等待 CLI 连接...' : snapshot.busy ? 'Claude 正在运行...' : '输入消息，点击发送。'}
            className="min-h-32 w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500"
            disabled={!canCompose}
          />

          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-red-600">{error || snapshot.lastError || ''}</div>
            <button
              type="submit"
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canCompose}
            >
              {snapshot.busy ? '处理中...' : '发送'}
            </button>
          </div>
        </form>

        <section className="rounded-3xl border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 px-4 py-3">
            <h2 className="text-lg font-semibold">Raw JSONL</h2>
          </div>
          <div className="p-4">
            {snapshot.rawJsonl ? (
              <pre className="max-h-[22rem] min-h-[14rem] overflow-auto rounded-2xl border border-zinc-200 bg-zinc-950 p-4 text-xs leading-5 whitespace-pre-wrap break-all text-zinc-100">
                {snapshot.rawJsonl}
              </pre>
            ) : (
              <div className="flex min-h-[14rem] items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                等待 Claude jsonl 原始内容。
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
