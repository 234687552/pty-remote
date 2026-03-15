import { Children, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Mermaid as MermaidApi } from 'mermaid';
import type { PanZoom as PanZoomInstance } from 'panzoom';

import type {
  ChatMessage,
  ChatMessageBlock,
  MessageStatus,
  ProviderId,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '@shared/runtime-types.ts';

import { MobileHeaderVisibilityContext } from '@/app-shell/AppShell.tsx';

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

interface ToolCallMeta {
  resultBlock?: ToolResultChatMessageBlock;
  resultStatus?: MessageStatus;
  toolName?: string;
  useBlockId?: string;
}

interface ChatPaneProps {
  activeProviderId: ProviderId | null;
  connected: boolean;
  hasOlderMessages: boolean;
  messages: ChatMessage[];
  olderMessagesLoading: boolean;
  visible: boolean;
  onLoadOlderMessages: (beforeMessageId: string | undefined) => Promise<boolean>;
}

const QUESTION_JUMP_LONG_PRESS_DELAY_MS = 420;

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
      const renderHost = createMermaidRenderHost();

      try {
        const mermaidApi = await loadMermaid();
        const renderId = `mermaid-diagram-${++mermaidRenderSequence}`;
        const { svg: nextSvg, bindFunctions } = await mermaidApi.render(renderId, definition, renderHost);
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
      } finally {
        renderHost.remove();
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

const MessageMarkdown = memo(function MessageMarkdown({
  content,
  tone = 'default'
}: {
  content: string;
  tone?: 'default' | 'inverse' | 'muted';
}) {
  const isInverse = tone === 'inverse';
  const isMuted = tone === 'muted';

  return (
    <div
      className={[
        'markdown-body space-y-3 leading-6',
        isInverse ? 'text-zinc-950' : isMuted ? 'text-zinc-500 italic' : 'text-zinc-800'
      ].join(' ')}
    >
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
                  ? 'border-l-2 border-sky-300 pl-4 text-zinc-700'
                  : isMuted
                    ? 'border-l-2 border-zinc-200 pl-4 text-zinc-500'
                    : 'border-l-2 border-zinc-300 pl-4 text-zinc-600'
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
            <h1 {...props} className={isMuted ? 'text-lg font-semibold text-zinc-600 italic' : 'text-lg font-semibold text-zinc-950'} />
          ),
          h2: ({ ...props }) => (
            <h2 {...props} className={isMuted ? 'text-base font-semibold text-zinc-600 italic' : 'text-base font-semibold text-zinc-950'} />
          ),
          h3: ({ ...props }) => (
            <h3 {...props} className={isMuted ? 'text-sm font-semibold text-zinc-600 italic' : 'text-sm font-semibold text-zinc-950'} />
          ),
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
                    ? 'overflow-x-auto rounded-xl border border-sky-200 bg-sky-100'
                    : isMuted
                      ? 'overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-100 text-zinc-600 not-italic'
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
        : 'w-full py-2.5 text-sm break-words text-zinc-900';

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

function ToolUseBlockContent({
  block,
  resultBlock,
  status
}: {
  block: ToolUseChatMessageBlock;
  resultBlock?: ToolResultChatMessageBlock;
  status: MessageStatus;
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

function MessageContent({ message, toolCallIndex }: { message: ChatMessage; toolCallIndex: Map<string, ToolCallMeta> }) {
  if (message.blocks.length === 0) {
    return null;
  }

  const isReasoning = isCodexReasoningMessage(message);

  return (
    <div className="space-y-2">
      {message.blocks.map((block, index) => {
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

export function ChatPane({ activeProviderId, connected, hasOlderMessages, messages, olderMessagesLoading, visible, onLoadOlderMessages }: ChatPaneProps) {
  const setMobileHeaderVisible = useContext(MobileHeaderVisibilityContext);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const preserveMessagesScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const questionJumpPressTimeoutRef = useRef<number | null>(null);
  const questionJumpLongPressTriggeredRef = useRef(false);
  const questionMessageRefs = useRef(new Map<string, HTMLDivElement>());
  const previousMessagesScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const [isNearTop, setIsNearTop] = useState(true);
  const showOlderMessagesButton = hasOlderMessages && (activeProviderId !== 'codex' || isNearTop);

  const renderableMessages = useMemo(() => messages.filter((message) => hasRenderableMessageContent(message)), [messages]);
  const toolCallIndex = useMemo(() => createToolCallIndex(renderableMessages), [renderableMessages]);
  const questionMessageIds = useMemo(
    () => renderableMessages.filter((message) => message.role === 'user').map((message) => message.id),
    [renderableMessages]
  );

  useEffect(() => {
    previousMessagesScrollTopRef.current = messagesRef.current?.scrollTop ?? 0;
  }, [visible]);

  useEffect(() => {
    return () => {
      if (questionJumpPressTimeoutRef.current !== null) {
        window.clearTimeout(questionJumpPressTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    const preservedScroll = preserveMessagesScrollRef.current;
    if (preservedScroll) {
      messagesElement.scrollTop = preservedScroll.scrollTop + (messagesElement.scrollHeight - preservedScroll.scrollHeight);
      preserveMessagesScrollRef.current = null;
      setIsNearTop(messagesElement.scrollTop <= 12);
      return;
    }

    messagesElement.scrollTo({ top: messagesElement.scrollHeight });
    setIsNearTop(false);
  }, [renderableMessages]);

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
    const nextTop = event.currentTarget.scrollTop;
    const previousTop = previousMessagesScrollTopRef.current;
    const delta = nextTop - previousTop;
    previousMessagesScrollTopRef.current = nextTop;

    const nextNearTop = nextTop <= 12;
    if (nextNearTop !== isNearTop) {
      setIsNearTop(nextNearTop);
    }

    if (Math.abs(delta) < 6) {
      return;
    }

    setMobileHeaderVisible(delta < 0);
  }

  function handleMessagesTouchStart(event: React.TouchEvent<HTMLDivElement>): void {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handleMessagesTouchMove(event: React.TouchEvent<HTMLDivElement>): void {
    const touchStartY = touchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (touchStartY == null || currentY == null) {
      return;
    }

    if (event.currentTarget.scrollTop > 4) {
      return;
    }

    const deltaY = currentY - touchStartY;
    if (deltaY > 14) {
      setMobileHeaderVisible(true);
    } else if (deltaY < -8) {
      setMobileHeaderVisible(false);
    }
  }

  function handleMessagesTouchEnd(): void {
    touchStartYRef.current = null;
  }

  function handleJumpToMessagesEdge(direction: 'up' | 'down'): void {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({
      top: direction === 'up' ? 0 : container.scrollHeight,
      behavior: 'smooth'
    });
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

  async function handleLoadOlderMessages(): Promise<void> {
    if (messagesRef.current) {
      preserveMessagesScrollRef.current = {
        scrollHeight: messagesRef.current.scrollHeight,
        scrollTop: messagesRef.current.scrollTop
      };
    }

    try {
      const loaded = await onLoadOlderMessages(messages[0]?.id);
      if (!loaded) {
        preserveMessagesScrollRef.current = null;
      }
    } catch {
      preserveMessagesScrollRef.current = null;
    }
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
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Messages</h2>
            </div>
            {showOlderMessagesButton ? (
              <button
                type="button"
                onClick={() => {
                  void handleLoadOlderMessages();
                }}
                className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!connected || olderMessagesLoading}
              >
                {olderMessagesLoading ? '加载中...' : '加载更早消息'}
              </button>
            ) : null}
          </div>
        </div>
        {showOlderMessagesButton ? (
          <div className="px-1 pb-2 lg:hidden">
            <button
              type="button"
              onClick={() => {
                void handleLoadOlderMessages();
              }}
              className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!connected || olderMessagesLoading}
            >
              {olderMessagesLoading ? '加载中...' : '加载更早消息'}
            </button>
          </div>
        ) : null}
        <div
          ref={messagesRef}
          onScroll={handleMessagesScroll}
          onTouchStart={handleMessagesTouchStart}
          onTouchMove={handleMessagesTouchMove}
          onTouchEnd={handleMessagesTouchEnd}
          onTouchCancel={handleMessagesTouchEnd}
          className="min-h-0 min-w-0 flex-1 space-y-2 overflow-auto px-1 py-4 sm:px-3 lg:px-4"
        >
          {renderableMessages.length === 0
            ? null
            : renderableMessages.map((message) => (
                <div
                  key={message.id}
                  ref={message.role === 'user' ? (node) => setQuestionMessageRef(message.id, node) : undefined}
                >
                  <MessageShell message={message}>
                    <MessageContent message={message} toolCallIndex={toolCallIndex} />
                  </MessageShell>
                </div>
              ))}
        </div>

        {questionMessageIds.length > 0 ? (
          <div className="pointer-events-none absolute right-3 bottom-14 z-10 md:right-4 md:bottom-16">
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
