import { Children, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Mermaid as MermaidApi } from 'mermaid';
import type { PanZoom as PanZoomInstance } from 'panzoom';

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
let panzoomLoader: Promise<typeof import('panzoom').default> | null = null;

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
  const expandedViewportRef = useRef<HTMLDivElement | null>(null);
  const expandedPanTargetRef = useRef<HTMLDivElement | null>(null);
  const expandedContentRef = useRef<HTMLDivElement | null>(null);
  const expandedPanzoomRef = useRef<PanZoomInstance | null>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | null>(null);
  const [svg, setSvg] = useState('');
  const [svgDimensions, setSvgDimensions] = useState<SvgDimensions | null>(null);
  const [error, setError] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);

  const closeExpandedViewer = () => {
    setIsExpanded(false);
    setIsLandscape(false);
  };

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
              <div
                ref={expandedPanTargetRef}
                className="absolute top-0 left-0"
              >
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

function getToolVariant(toolName: string | undefined): { tone: ToolVariantTone } {
  const normalized = (toolName || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { tone: 'generic' };
  }

  if (lower.includes('bash') || lower.includes('shell') || lower.includes('terminal')) {
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

function getCompactToolTitle(toolName: string | undefined): string {
  const normalized = (toolName || '').trim();

  if (!normalized) {
    return 'Tool';
  }

  return normalized;
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
  const shellClass =
    message.role === 'user'
      ? 'w-fit max-w-[85%] rounded-2xl bg-zinc-900 px-3.5 py-2.5 text-sm break-words text-white shadow-sm'
      : message.status === 'error'
        ? 'w-fit max-w-[85%] rounded-2xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm break-words text-zinc-900 shadow-sm'
        : 'w-full py-2.5 text-sm break-words text-zinc-900';

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

type MobilePane = 'chat' | 'terminal' | 'jsonl';

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
  const [isExpanded, setIsExpanded] = useState(false);
  const variant = getToolVariant(block.toolName);
  const compactTitle = getCompactToolTitle(block.toolName);
  const toneClasses = getToolToneClasses(variant.tone);
  const summaryPreview = getToolInputPreview(block.input, 112);
  const closeExpandedViewer = () => {
    setIsExpanded(false);
  };

  useEffect(() => {
    if (!isExpanded) {
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

      {isExpanded ? (
        <div
          className="fixed inset-0 z-50 bg-zinc-950/72 backdrop-blur-sm"
          onClick={closeExpandedViewer}
        >
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
                  onClick={closeExpandedViewer}
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
  const [mobilePane, setMobilePane] = useState<MobilePane>('chat');

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
    if (mobilePane !== 'terminal') {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [mobilePane]);

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
      setMobilePane('chat');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '发送失败');
    }
  }

  async function handleReset() {
    try {
      setError('');
      await sendCommand('reset-session', {});
      setMobilePane('chat');
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

        <nav className="rounded-2xl border border-zinc-200 bg-white p-1 shadow-sm lg:hidden" aria-label="Mobile panels">
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ['chat', 'Chat'],
                ['terminal', 'Terminal'],
                ['jsonl', 'JSONL']
              ] as const satisfies ReadonlyArray<readonly [MobilePane, string]>
            ).map(([pane, label]) => (
              <button
                key={pane}
                type="button"
                onClick={() => setMobilePane(pane)}
                className={[
                  'rounded-xl px-3 py-2 text-sm font-medium transition',
                  mobilePane === pane ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                ].join(' ')}
                aria-pressed={mobilePane === pane}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>

        <section
          className={[
            'min-h-0 flex-col gap-4 lg:grid lg:grid-cols-[1fr,1.2fr]',
            mobilePane === 'jsonl' ? 'hidden lg:grid' : 'flex'
          ].join(' ')}
        >
          <div
            className={[
              'min-h-[22rem] flex-col rounded-3xl border border-zinc-200 bg-white shadow-sm sm:min-h-[24rem] lg:flex lg:min-h-[28rem]',
              mobilePane === 'chat' ? 'flex' : 'hidden'
            ].join(' ')}
          >
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

          <div
            className={[
              'min-h-[22rem] flex-col rounded-3xl border border-zinc-200 bg-white shadow-sm sm:min-h-[24rem] lg:flex lg:min-h-[28rem]',
              mobilePane === 'terminal' ? 'flex' : 'hidden'
            ].join(' ')}
          >
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-lg font-semibold">Terminal</h2>
            </div>
            <div className="terminal-shell flex-1 overflow-hidden rounded-b-3xl bg-slate-950 p-3">
              <div ref={terminalHostRef} className="h-full w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950" />
            </div>
          </div>
        </section>

        <form onSubmit={handleSubmit} className="order-5 rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm lg:order-4">
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
            className="min-h-28 w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500 md:min-h-32"
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

        <section
          className={[
            'order-4 rounded-3xl border border-zinc-200 bg-white shadow-sm lg:order-5 lg:block',
            mobilePane === 'jsonl' ? 'block' : 'hidden'
          ].join(' ')}
        >
          <div className="border-b border-zinc-200 px-4 py-3">
            <h2 className="text-lg font-semibold">Raw JSONL</h2>
          </div>
          <div className="p-4">
            {snapshot.rawJsonl ? (
              <pre className="max-h-[18rem] min-h-[12rem] overflow-auto rounded-2xl border border-zinc-200 bg-zinc-950 p-4 text-xs leading-5 whitespace-pre-wrap break-all text-zinc-100 sm:max-h-[22rem] sm:min-h-[14rem]">
                {snapshot.rawJsonl}
              </pre>
            ) : (
              <div className="flex min-h-[12rem] items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500 sm:min-h-[14rem]">
                等待 Claude jsonl 原始内容。
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
