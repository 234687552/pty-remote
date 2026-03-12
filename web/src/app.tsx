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
  GetOlderMessagesResultPayload,
  GetRuntimeSnapshotResultPayload,
  ListProjectSessionsResultPayload,
  MessagesUpsertPayload,
  PickProjectDirectoryResultPayload,
  ProjectSessionSummary,
  RuntimeSnapshotPayload,
  TerminalChunkPayload,
  TerminalResizePayload,
  TerminalResumeRequestPayload,
  TerminalResumeResultPayload,
  WebCommandEnvelope,
  WebInitPayload
} from '@shared/protocol.ts';
import type {
  ChatMessage,
  ChatMessageBlock,
  CliDescriptor,
  MessageStatus,
  RuntimeSnapshot,
  RuntimeStatus,
  ToolResultChatMessageBlock,
  ToolUseChatMessageBlock
} from '@shared/runtime-types.ts';

function createEmptySnapshot(): RuntimeSnapshot {
  return {
    threadKey: null,
    status: 'idle',
    sessionId: null,
    messages: [],
    hasOlderMessages: false,
    lastError: null
  };
}

function isBusyStatus(status: RuntimeStatus): boolean {
  return status === 'starting' || status === 'running';
}

function getRuntimeStatusLabel(status: RuntimeStatus): string {
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

function isCliOfflineMessage(message: string | null | undefined): boolean {
  return (message ?? '').trim() === 'CLI is offline';
}

function getSocketBaseUrl(): string {
  const envValue = import.meta.env.VITE_SOCKET_URL;
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  return window.location.origin;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function getThreadLabel(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || cwd;
}

const PROJECTS_STORAGE_KEY = 'pty-remote.projects.v1';
const SIDEBAR_TOGGLE_MARGIN = 16;
const SIDEBAR_TOGGLE_SIZE = 72;
const MOBILE_TERMINAL_BREAKPOINT = 768;
const MOBILE_TERMINAL_MIN_COLS = 80;

function clampSidebarToggleTop(value: number, viewportHeight: number): number {
  const minTop = SIDEBAR_TOGGLE_MARGIN;
  const maxTop = Math.max(minTop, viewportHeight - SIDEBAR_TOGGLE_SIZE - SIDEBAR_TOGGLE_MARGIN);
  return Math.min(maxTop, Math.max(minTop, Math.round(value)));
}

interface ProjectThreadEntry {
  id: string;
  threadKey: string;
  sessionId: string | null;
  title: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
  draft: boolean;
}

interface ProjectEntry {
  id: string;
  cliId: string;
  cwd: string;
  label: string;
}

interface PersistedWorkspaceState {
  activeCliId: string | null;
  activeProjectId: string | null;
  activeThreadId: string | null;
  projects: ProjectEntry[];
  sidebarCollapsed: boolean;
  sidebarToggleTop: number;
}

function createEmptyWorkspaceState(): PersistedWorkspaceState {
  return {
    activeCliId: null,
    activeProjectId: null,
    activeThreadId: null,
    projects: [],
    sidebarCollapsed: false,
    sidebarToggleTop: SIDEBAR_TOGGLE_MARGIN
  };
}

function loadWorkspaceState(): PersistedWorkspaceState {
  try {
    const rawValue = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!rawValue) {
      return createEmptyWorkspaceState();
    }

    const parsed = JSON.parse(rawValue) as PersistedWorkspaceState;
    if (!parsed || !Array.isArray(parsed.projects)) {
      return createEmptyWorkspaceState();
    }

    return {
      activeCliId: parsed.activeCliId ?? null,
      activeProjectId: parsed.activeProjectId ?? null,
      activeThreadId: parsed.activeThreadId ?? null,
      projects: parsed.projects
        .filter((project) => project && typeof project.cwd === 'string')
        .map((project) => ({
          id: project.id,
          cliId: typeof project.cliId === 'string' ? project.cliId : '',
          cwd: project.cwd,
          label: project.label
        })),
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      sidebarToggleTop: clampSidebarToggleTop(
        typeof parsed.sidebarToggleTop === 'number' ? parsed.sidebarToggleTop : SIDEBAR_TOGGLE_MARGIN,
        window.innerHeight
      )
    };
  } catch {
    return createEmptyWorkspaceState();
  }
}

function saveWorkspaceState(state: PersistedWorkspaceState): void {
  window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(state));
}

function compactPreview(text: string, maxChars = 56): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Untitled thread';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function getMessagePlainText(message: ChatMessage | undefined): string {
  if (!message) {
    return '';
  }

  return message.blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      if (block.type === 'tool_use') {
        return `${block.toolName} ${block.input}`;
      }
      return block.content;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createDraftThread(label = 'New thread'): ProjectThreadEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    threadKey: crypto.randomUUID(),
    sessionId: null,
    title: label,
    preview: 'Start a new Claude session in this project.',
    updatedAt: now,
    messageCount: 0,
    draft: true
  };
}

function createThreadFromSession(session: ProjectSessionSummary): ProjectThreadEntry {
  return {
    id: session.sessionId,
    threadKey: session.sessionId,
    sessionId: session.sessionId,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    draft: false
  };
}

function sortThreads(threads: ProjectThreadEntry[]): ProjectThreadEntry[] {
  return [...threads].sort((left, right) => {
    if (left.draft !== right.draft) {
      return left.draft ? -1 : 1;
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

function mergeProjectThreads(existingThreads: ProjectThreadEntry[], sessions: ProjectSessionSummary[]): ProjectThreadEntry[] {
  const drafts = existingThreads.filter((thread) => thread.draft && !thread.sessionId);
  const existingBySessionId = new Map<string, ProjectThreadEntry>();
  for (const thread of existingThreads) {
    if (!thread.sessionId || existingBySessionId.has(thread.sessionId)) {
      continue;
    }
    existingBySessionId.set(thread.sessionId, thread);
  }

  const merged = sessions.map((session) => {
    const existing = existingBySessionId.get(session.sessionId);
    return {
      ...(existing ?? createThreadFromSession(session)),
      sessionId: session.sessionId,
      title: session.title,
      preview: session.preview,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      draft: false
    };
  });

  return sortThreads([...drafts, ...merged]);
}

function sortProjects(projects: ProjectEntry[]): ProjectEntry[] {
  return [...projects].sort((left, right) => left.label.localeCompare(right.label));
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
        const renderContainer = document.createElement('div');
        const { svg: nextSvg, bindFunctions } = await mermaidApi.render(renderId, definition, renderContainer);
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
    <div className={`markdown-body space-y-3 leading-6 ${isInverse ? 'text-zinc-950' : 'text-zinc-800'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a
              {...props}
              className={isInverse ? 'text-sky-900 underline underline-offset-2' : 'text-blue-700 underline underline-offset-2'}
              target="_blank"
              rel="noreferrer"
            />
          ),
          blockquote: ({ ...props }) => (
            <blockquote
              {...props}
              className={isInverse ? 'border-l-2 border-sky-300 pl-4 text-zinc-700' : 'border-l-2 border-zinc-300 pl-4 text-zinc-600'}
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
                    : 'rounded bg-zinc-200 px-1.5 py-0.5 text-[0.85em] text-zinc-900'
                }
              >
                {children}
              </code>
            );
          },
          h1: ({ ...props }) => <h1 {...props} className={isInverse ? 'text-lg font-semibold text-zinc-950' : 'text-lg font-semibold text-zinc-950'} />,
          h2: ({ ...props }) => <h2 {...props} className={isInverse ? 'text-base font-semibold text-zinc-950' : 'text-base font-semibold text-zinc-950'} />,
          h3: ({ ...props }) => <h3 {...props} className={isInverse ? 'text-sm font-semibold text-zinc-950' : 'text-sm font-semibold text-zinc-950'} />,
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

function parseStructuredToolInput(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid JSON input previews
  }

  return null;
}

function getStructuredToolInputField(input: string, field: string): string | null {
  const parsed = parseStructuredToolInput(input);
  const value = parsed?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function getCompactToolTitle(toolName: string | undefined, input: string): string {
  const normalized = (toolName || '').trim();

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

  if (!normalized) {
    return 'Tool';
  }

  return normalized;
}

function getCompactToolPreview(toolName: string | undefined, input: string, maxChars = 180): string {
  const normalized = (toolName || '').trim();

  if (normalized === 'Task') {
    const prompt = getStructuredToolInputField(input, 'prompt');
    if (prompt) {
      return getToolInputPreview(prompt, maxChars);
    }
  }

  return getToolInputPreview(input, maxChars);
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

interface ToolCallMeta {
  toolName?: string;
  useBlockId?: string;
  resultBlock?: ToolResultChatMessageBlock;
  resultStatus?: MessageStatus;
}

type MobilePane = 'chat' | 'terminal';
type QuestionJumpDirection = 'up' | 'down';

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

function mergeChronologicalMessages(left: ChatMessage[], right: ChatMessage[]): ChatMessage[] {
  const merged = [...left];
  const indexById = new Map(merged.map((message, index) => [message.id, index]));

  for (const message of right) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, merged.length);
      merged.push(message);
      continue;
    }

    merged[existingIndex] = message;
  }

  return merged;
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
  const compactTitle = getCompactToolTitle(block.toolName, block.input);
  const toneClasses = getToolToneClasses(variant.tone);
  const summaryPreview = getCompactToolPreview(block.toolName, block.input, 112);
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
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(createEmptySnapshot());
  const [workspaceState, setWorkspaceState] = useState<PersistedWorkspaceState>(() => loadWorkspaceState());
  const [projectThreadsById, setProjectThreadsById] = useState<Record<string, ProjectThreadEntry[]>>({});
  const [sidebarToggleTop, setSidebarToggleTop] = useState(() => workspaceState.sidebarToggleTop);
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [mobilePane, setMobilePane] = useState<MobilePane>('chat');
  const [projectLoadingId, setProjectLoadingId] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const questionMessageRefs = useRef(new Map<string, HTMLDivElement>());
  const terminalViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lastTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const appliedTerminalOffsetRef = useRef(0);
  const appliedSessionIdRef = useRef<string | null>(null);
  const terminalResumePendingRef = useRef(false);
  const terminalResyncRequestedRef = useRef(false);
  const bufferedTerminalChunksRef = useRef<TerminalChunkPayload[]>([]);
  const activeCliIdRef = useRef<string | null>(null);
  const preserveMessagesScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const requestedThreadKeyRef = useRef<string | null>(null);
  const sidebarToggleDragRef = useRef<{ pointerId: number; startY: number; startTop: number; moved: boolean } | null>(null);
  const suppressSidebarToggleClickRef = useRef(false);
  const questionJumpClickTimeoutRef = useRef<number | null>(null);

  function applyTerminalReplay(sessionId: string | null, replay: string, replayOffset: number): void {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    terminal.reset();

    const finalizeReplay = () => {
      appliedSessionIdRef.current = sessionId;
      appliedTerminalOffsetRef.current = replayOffset + getUtf8ByteLength(replay);
      terminal.scrollToBottom();
      scheduleTerminalRedraw();
    };

    if (!replay) {
      finalizeReplay();
      return;
    }

    terminal.write(replay, finalizeReplay);
  }

  function scheduleTerminalRedraw(): void {
    requestAnimationFrame(() => {
      scheduleTerminalResize();
      requestAnimationFrame(() => {
        const terminal = terminalInstanceRef.current;
        if (!terminal || terminal.rows <= 0) {
          return;
        }
        terminal.refresh(0, terminal.rows - 1);
      });
    });
  }

  function emitTerminalResize(): void {
    const socket = socketRef.current;
    const terminal = terminalInstanceRef.current;
    const fitAddon = fitAddonRef.current;
    const terminalHost = terminalHostRef.current;
    const terminalViewport = terminalViewportRef.current;
    if (!socket?.connected || !terminal || !fitAddon || !terminalHost || !terminalViewport) {
      return;
    }

    terminalHost.style.width = '100%';
    terminalHost.style.minWidth = '100%';
    fitAddon.fit();
    const proposedDimensions = fitAddon.proposeDimensions();
    const cols = proposedDimensions?.cols ?? terminal.cols;
    const rows = proposedDimensions?.rows ?? terminal.rows;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return;
    }

    const viewportWidth = terminalViewport.clientWidth;
    const shouldAllowHorizontalScroll = viewportWidth > 0 && viewportWidth < MOBILE_TERMINAL_BREAKPOINT;
    const nextSize = {
      cols: Math.max(shouldAllowHorizontalScroll ? MOBILE_TERMINAL_MIN_COLS : 20, cols),
      rows: Math.max(8, rows)
    };

    if (shouldAllowHorizontalScroll && cols > 0) {
      const targetWidth = Math.ceil((viewportWidth / cols) * nextSize.cols);
      terminalHost.style.width = `${targetWidth}px`;
      terminalHost.style.minWidth = `${targetWidth}px`;
    } else {
      terminalHost.style.width = '100%';
      terminalHost.style.minWidth = '100%';
    }

    if (terminal.cols !== nextSize.cols || terminal.rows !== nextSize.rows) {
      terminal.resize(nextSize.cols, nextSize.rows);
    }

    if (lastTerminalSizeRef.current?.cols === nextSize.cols && lastTerminalSizeRef.current?.rows === nextSize.rows) {
      return;
    }

    lastTerminalSizeRef.current = nextSize;
    socket.emit('web:terminal-resize', {
      targetCliId: activeCliId,
      ...nextSize
    } satisfies TerminalResizePayload);
  }

  function scheduleTerminalResize(): void {
    if (resizeFrameRef.current) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      emitTerminalResize();
    });
  }

  function scheduleTerminalResync(sessionId: string | null): void {
    if (terminalResumePendingRef.current || terminalResyncRequestedRef.current) {
      return;
    }

    terminalResyncRequestedRef.current = true;
    terminalResumePendingRef.current = true;
    bufferedTerminalChunksRef.current = [];
    setError('终端流已失步，正在自动重连同步...');
    void requestTerminalResume(sessionId).finally(() => {
      terminalResyncRequestedRef.current = false;
    });
  }

  function applyTerminalChunk(payload: TerminalChunkPayload): boolean {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return true;
    }
    if (!payload.sessionId || payload.sessionId !== appliedSessionIdRef.current) {
      return true;
    }

    const chunkEndOffset = payload.offset + getUtf8ByteLength(payload.data);
    if (chunkEndOffset <= appliedTerminalOffsetRef.current) {
      return true;
    }
    if (payload.offset !== appliedTerminalOffsetRef.current) {
      scheduleTerminalResync(payload.sessionId);
      return false;
    }

    terminal.write(payload.data);
    appliedTerminalOffsetRef.current = chunkEndOffset;
    return true;
  }

  function flushBufferedTerminalChunks(): void {
    const pendingChunks = bufferedTerminalChunksRef.current
      .splice(0)
      .sort((left, right) => left.offset - right.offset);

    for (const chunk of pendingChunks) {
      applyTerminalChunk(chunk);
    }
  }

  async function requestTerminalResume(targetSessionId: string | null): Promise<void> {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }

    const payload: TerminalResumeRequestPayload =
      appliedSessionIdRef.current === targetSessionId
        ? {
            targetCliId: activeCliId,
            sessionId: appliedSessionIdRef.current,
            lastOffset: appliedTerminalOffsetRef.current
          }
        : {
            targetCliId: activeCliId,
            sessionId: null,
            lastOffset: 0
          };

    const result = await new Promise<TerminalResumeResultPayload>((resolve) => {
      socket.emit('web:terminal-resume', payload, (resumePayload?: TerminalResumeResultPayload) => {
        resolve(
          resumePayload ?? {
            mode: 'reset',
            sessionId: targetSessionId,
            offset: 0,
            data: ''
          }
        );
      });
    });

    if (result.mode === 'reset') {
      applyTerminalReplay(result.sessionId, result.data, result.offset);
    } else {
      applyTerminalChunk({
        cliId: activeCliId ?? '',
        data: result.data,
        offset: result.offset,
        sessionId: result.sessionId
      });
    }

    terminalResumePendingRef.current = false;
    setError((current) => (current === '终端流已失步，正在自动重连同步...' ? '' : current));
    flushBufferedTerminalChunks();
  }

  const visibleMessages = useMemo(
    () => mergeChronologicalMessages(olderMessages, snapshot.messages),
    [olderMessages, snapshot.messages]
  );
  const toolCallIndex = useMemo(() => createToolCallIndex(visibleMessages), [visibleMessages]);
  const renderableMessages = useMemo(
    () => visibleMessages.filter((message) => hasRenderableMessageContent(message)),
    [visibleMessages]
  );
  const questionMessageIds = useMemo(
    () => renderableMessages.filter((message) => message.role === 'user').map((message) => message.id),
    [renderableMessages]
  );
  const activeProject = useMemo(
    () => workspaceState.projects.find((project) => project.id === workspaceState.activeProjectId) ?? null,
    [workspaceState.activeProjectId, workspaceState.projects]
  );
  const activeCliId = activeProject?.cliId ?? workspaceState.activeCliId;
  const activeCli = useMemo(
    () => clis.find((cli) => cli.cliId === activeCliId) ?? null,
    [activeCliId, clis]
  );
  const activeProjectThreads = useMemo(
    () => (activeProject ? projectThreadsById[activeProject.id] ?? [] : []),
    [activeProject, projectThreadsById]
  );
  const activeThread = useMemo(
    () => activeProjectThreads.find((thread) => thread.id === workspaceState.activeThreadId) ?? activeProjectThreads[0] ?? null,
    [activeProjectThreads, workspaceState.activeThreadId]
  );
  const connected = Boolean(socketConnected && activeCli?.connected);
  const busy = isBusyStatus(snapshot.status);
  const canSend = connected && !busy && Boolean(activeProject && activeThread);
  const canStop = connected && busy && Boolean(activeProject && activeThread);

  useEffect(() => {
    activeCliIdRef.current = activeCliId ?? null;
  }, [activeCliId]);

  useEffect(() => {
    if (!terminalHostRef.current || !terminalViewportRef.current || terminalInstanceRef.current) {
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
        background: '#ffffff',
        foreground: '#111827',
        cursor: '#111827',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(15, 23, 42, 0.12)'
      }
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminalInstanceRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      scheduleTerminalResize();
    });
    observer.observe(terminalViewportRef.current);
    scheduleTerminalResize();

    return () => {
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
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
      terminalResumePendingRef.current = true;
      terminalResyncRequestedRef.current = false;
      bufferedTerminalChunksRef.current = [];
      setSocketConnected(true);
      setError('');
      scheduleTerminalResize();
    });

    socket.on('disconnect', () => {
      terminalResyncRequestedRef.current = false;
      setSocketConnected(false);
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

      setSnapshot(payload.snapshot);
    });

    socket.on('runtime:messages-upsert', (payload: MessagesUpsertPayload) => {
      if (payload.cliId !== activeCliIdRef.current) {
        return;
      }

      setSnapshot((current) => {
        const isSameThread = current.threadKey === payload.threadKey;
        const baseSnapshot = isSameThread
          ? current
          : {
              ...current,
              threadKey: payload.threadKey,
              sessionId: payload.sessionId,
              messages: [],
              hasOlderMessages: false
            };

        const messagesById = new Map(baseSnapshot.messages.map((message) => [message.id, message]));
        for (const message of payload.upserts) {
          messagesById.set(message.id, message);
        }

        return {
          ...baseSnapshot,
          messages: payload.recentMessageIds
            .map((messageId) => messagesById.get(messageId))
            .filter(Boolean) as ChatMessage[],
          hasOlderMessages: payload.hasOlderMessages
        };
      });
    });

    socket.on('terminal:chunk', (payload: TerminalChunkPayload) => {
      if (payload.cliId !== activeCliIdRef.current) {
        return;
      }

      if (terminalResumePendingRef.current) {
        bufferedTerminalChunksRef.current.push(payload);
        return;
      }
      applyTerminalChunk(payload);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!socketConnected) {
      return;
    }
    if (terminalResumePendingRef.current) {
      return;
    }
    if (appliedSessionIdRef.current === snapshot.sessionId) {
      return;
    }
    terminalResumePendingRef.current = true;
    bufferedTerminalChunksRef.current = [];
    void requestTerminalResume(snapshot.sessionId);
  }, [snapshot.sessionId, socketConnected]);

  useEffect(() => {
    setOlderMessages([]);
    setHasOlderMessages(snapshot.hasOlderMessages);
    setOlderMessagesLoading(false);
  }, [snapshot.sessionId]);

  useEffect(() => {
    if (olderMessages.length > 0) {
      return;
    }
    setHasOlderMessages(snapshot.hasOlderMessages);
  }, [olderMessages.length, snapshot.hasOlderMessages]);

  useEffect(() => {
    if (mobilePane === 'terminal') {
      scheduleTerminalResize();
    }
  }, [mobilePane]);

  useEffect(() => {
    scheduleTerminalResize();
  }, [workspaceState.sidebarCollapsed]);

  useEffect(() => {
    setSidebarToggleTop(workspaceState.sidebarToggleTop);
  }, [workspaceState.sidebarToggleTop]);

  useEffect(() => {
    const handleResize = () => {
      scheduleTerminalResize();
      setSidebarToggleTop((current) => clampSidebarToggleTop(current, window.innerHeight));
      setWorkspaceState((current) => {
        const nextTop = clampSidebarToggleTop(current.sidebarToggleTop, window.innerHeight);
        return current.sidebarToggleTop === nextTop ? current : { ...current, sidebarToggleTop: nextTop };
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (questionJumpClickTimeoutRef.current !== null) {
        window.clearTimeout(questionJumpClickTimeoutRef.current);
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
      return;
    }

    messagesElement.scrollTo({ top: messagesElement.scrollHeight });
  }, [renderableMessages]);

  useEffect(() => {
    saveWorkspaceState(workspaceState);
  }, [workspaceState]);

  useEffect(() => {
    if (clis.length !== 1 && workspaceState.activeCliId) {
      return;
    }

    const soleCliId = clis[0]?.cliId ?? null;
    const hasUnassignedProjects = workspaceState.projects.some((project) => !project.cliId);
    if (!soleCliId && !hasUnassignedProjects) {
      return;
    }

    patchWorkspace((current) => {
      const nextCliId = current.activeCliId ?? soleCliId;
      const nextProjects = current.projects.map((project) => (project.cliId ? project : { ...project, cliId: soleCliId ?? project.cliId }));
      const changed =
        nextCliId !== current.activeCliId ||
        nextProjects.some((project, index) => project.cliId !== current.projects[index]?.cliId);
      return changed ? { ...current, activeCliId: nextCliId, projects: nextProjects } : current;
    });
  }, [clis, workspaceState.activeCliId, workspaceState.projects]);

  useEffect(() => {
    if (activeProject && workspaceState.activeCliId !== activeProject.cliId) {
      patchWorkspace((current) =>
        current.activeProjectId === activeProject.id && current.activeCliId !== activeProject.cliId
          ? { ...current, activeCliId: activeProject.cliId }
          : current
      );
      return;
    }

    if (workspaceState.activeCliId || clis.length === 0) {
      return;
    }

    patchWorkspace((current) => (current.activeCliId ? current : { ...current, activeCliId: clis[0]?.cliId ?? null }));
  }, [activeProject, clis, workspaceState.activeCliId]);

  useEffect(() => {
    if (!activeProject || activeProjectThreads.length === 0 || activeThread) {
      return;
    }

    patchWorkspace((current) =>
      current.activeProjectId === activeProject.id && current.activeThreadId !== activeProjectThreads[0]?.id
        ? { ...current, activeThreadId: activeProjectThreads[0]?.id ?? null }
        : current
    );
  }, [activeProject, activeProjectThreads, activeThread]);

  useEffect(() => {
    if (!activeProject || !activeThread || !activeCli) {
      return;
    }

    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const canHydrateFromSnapshot = backendMatchesProject && snapshot.threadKey === activeThread.threadKey;

    if (!canHydrateFromSnapshot) {
      return;
    }

    const latestUserMessage = [...visibleMessages].reverse().find((message) => message.role === 'user');
    const latestMessage = visibleMessages[visibleMessages.length - 1];
    const previewSource = getMessagePlainText(latestUserMessage) || getMessagePlainText(latestMessage) || activeThread.preview;
    const nextTitle = compactPreview(previewSource || activeThread.title, 44);
    const nextPreview = compactPreview(previewSource || activeThread.preview, 88);
    const nextMessageCount = visibleMessages.length || activeThread.messageCount;
    const nextSessionId = snapshot.sessionId;
    const nextUpdatedAt = visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1]?.createdAt ?? activeThread.updatedAt : activeThread.updatedAt;

    setProjectThreadsById((current) => {
      const threads = current[activeProject.id] ?? [];
      let changed = false;
      const nextThreads = threads.map((thread) => {
        if (thread.id !== activeThread.id) {
          return thread;
        }

        const shouldUpdate =
          thread.sessionId !== nextSessionId ||
          thread.title !== nextTitle ||
          thread.preview !== nextPreview ||
          thread.updatedAt !== nextUpdatedAt ||
          thread.messageCount !== nextMessageCount ||
          thread.draft !== !nextSessionId;

        if (!shouldUpdate) {
          return thread;
        }

        changed = true;
        return {
          ...thread,
          sessionId: nextSessionId,
          title: nextTitle,
          preview: nextPreview,
          updatedAt: nextUpdatedAt,
          messageCount: nextMessageCount,
          draft: !nextSessionId
        };
      });

      return changed ? { ...current, [activeProject.id]: sortThreads(nextThreads) } : current;
    });
  }, [activeCli, activeProject, activeThread, snapshot.sessionId, snapshot.threadKey, visibleMessages]);

  useEffect(() => {
    if (!socketConnected || !activeCliId) {
      setSnapshot(createEmptySnapshot());
      applyTerminalReplay(null, '', 0);
      return;
    }

    terminalResumePendingRef.current = true;
    bufferedTerminalChunksRef.current = [];
    setSnapshot(createEmptySnapshot());
    setOlderMessages([]);
    setHasOlderMessages(false);
    setOlderMessagesLoading(false);

    void sendCommand('get-runtime-snapshot', {}, activeCliId)
      .then((result) => {
        const nextSnapshot = (result.payload as GetRuntimeSnapshotResultPayload | undefined)?.snapshot ?? createEmptySnapshot();
        setSnapshot(nextSnapshot);
        void requestTerminalResume(nextSnapshot.sessionId);
      })
      .catch((runtimeError) => {
        terminalResumePendingRef.current = false;
        applyTerminalReplay(null, '', 0);
        setError(runtimeError instanceof Error ? runtimeError.message : '加载 CLI 运行态失败');
      });
  }, [activeCliId, socketConnected]);

  useEffect(() => {
    if (!socketConnected) {
      return;
    }

    const nextProjectToLoad = workspaceState.projects.find(
      (project) => project.cliId && !projectThreadsById[project.id] && projectLoadingId !== project.id
    );
    if (!nextProjectToLoad) {
      return;
    }

    void refreshProjectThreads(nextProjectToLoad);
  }, [projectLoadingId, projectThreadsById, socketConnected, workspaceState.projects]);

  useEffect(() => {
    if (!socketConnected || !activeCli?.connected || !activeProject || !activeThread) {
      return;
    }

    const threadKey = activeThread.threadKey;
    const requestKey = `${activeProject.cliId}:${threadKey}:${activeThread.sessionId ?? 'draft'}`;
    const backendMatchesProject = activeCli.cwd === activeProject.cwd;
    const backendMatchesThread = (snapshot.threadKey ?? activeCli.threadKey ?? null) === threadKey;

    if (backendMatchesProject && backendMatchesThread) {
      requestedThreadKeyRef.current = requestKey;
      return;
    }

    if (requestedThreadKeyRef.current === requestKey) {
      return;
    }

    requestedThreadKeyRef.current = requestKey;
    void activateThread(activeProject, activeThread);
  }, [activeCli, activeProject, activeThread, snapshot.threadKey, socketConnected]);

  const headerText = useMemo(() => {
    if (!socketConnected) {
      return 'waiting for socket';
    }
    if (!activeCli?.connected) {
      return 'waiting for cli';
    }
    return getRuntimeStatusLabel(snapshot.status);
  }, [activeCli?.connected, snapshot.status, socketConnected]);

  const statusBadgeClassName = useMemo(() => {
    if (!socketConnected || !activeCli?.connected || snapshot.status === 'error') {
      return 'bg-red-100 text-red-700';
    }
    if (busy) {
      return 'bg-zinc-900 text-white';
    }
    return 'bg-white/85 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]';
  }, [activeCli?.connected, busy, snapshot.status, socketConnected]);

  const footerErrorText = useMemo(() => {
    if (error && !isCliOfflineMessage(error)) {
      return error;
    }
    if (snapshot.lastError && !isCliOfflineMessage(snapshot.lastError)) {
      return snapshot.lastError;
    }
    return '';
  }, [error, snapshot.lastError]);

  const headerSummary = useMemo(
    () => [
      `CLI ${compactPreview(activeCli?.label ?? 'unselected', 28)}`,
      `项目 ${compactPreview(activeProject?.label ?? activeCli?.label ?? 'Workspace', 28)}`,
      `目录 ${compactPreview(activeProject?.cwd ?? activeCli?.cwd ?? '-', 56)}`,
      `线程 ${compactPreview(activeThread?.title ?? '-', 36)}`,
      `会话 ${compactPreview(activeThread?.sessionId ?? snapshot.sessionId ?? '-', 24)}`
    ],
    [activeCli?.cwd, activeCli?.label, activeProject?.cwd, activeProject?.label, activeThread?.sessionId, activeThread?.title, snapshot.sessionId]
  );

  async function sendCommand<TName extends CliCommandName>(
    name: TName,
    payload: CliCommandPayloadMap[TName],
    targetCliId = activeCliId
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

  function patchWorkspace(updater: (current: PersistedWorkspaceState) => PersistedWorkspaceState): void {
    setWorkspaceState((current) => updater(current));
  }

  function setProjectThreads(projectId: string, updater: (threads: ProjectThreadEntry[]) => ProjectThreadEntry[]): void {
    setProjectThreadsById((current) => ({
      ...current,
      [projectId]: updater(current[projectId] ?? [])
    }));
  }

  function setQuestionMessageRef(messageId: string, node: HTMLDivElement | null): void {
    if (node) {
      questionMessageRefs.current.set(messageId, node);
      return;
    }
    questionMessageRefs.current.delete(messageId);
  }

  function handleJumpToQuestion(direction: QuestionJumpDirection): void {
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

  function handleJumpToMessagesEdge(direction: QuestionJumpDirection): void {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({
      top: direction === 'up' ? 0 : container.scrollHeight,
      behavior: 'smooth'
    });
  }

  function handleQuestionJumpButtonClick(direction: QuestionJumpDirection): void {
    if (questionJumpClickTimeoutRef.current !== null) {
      window.clearTimeout(questionJumpClickTimeoutRef.current);
    }

    questionJumpClickTimeoutRef.current = window.setTimeout(() => {
      questionJumpClickTimeoutRef.current = null;
      handleJumpToQuestion(direction);
    }, 220);
  }

  function handleQuestionJumpButtonDoubleClick(direction: QuestionJumpDirection): void {
    if (questionJumpClickTimeoutRef.current !== null) {
      window.clearTimeout(questionJumpClickTimeoutRef.current);
      questionJumpClickTimeoutRef.current = null;
    }

    handleJumpToMessagesEdge(direction);
  }

  function handleTerminalJumpToEdge(direction: QuestionJumpDirection): void {
    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    if (direction === 'up') {
      terminal.scrollToTop();
      return;
    }

    terminal.scrollToBottom();
  }

  function handleOpenSidebarButtonClick(event: React.MouseEvent<HTMLButtonElement>): void {
    if (suppressSidebarToggleClickRef.current) {
      suppressSidebarToggleClickRef.current = false;
      event.preventDefault();
      return;
    }
    patchWorkspace((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
  }

  function handleSidebarTogglePointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) {
      return;
    }
    sidebarToggleDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTop: sidebarToggleTop,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSidebarTogglePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const dragState = sidebarToggleDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const nextTop = clampSidebarToggleTop(dragState.startTop + (event.clientY - dragState.startY), window.innerHeight);
    if (Math.abs(nextTop - dragState.startTop) > 3) {
      dragState.moved = true;
    }
    setSidebarToggleTop(nextTop);
  }

  function handleSidebarTogglePointerRelease(event: React.PointerEvent<HTMLButtonElement>): void {
    const dragState = sidebarToggleDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const nextTop = clampSidebarToggleTop(dragState.startTop + (event.clientY - dragState.startY), window.innerHeight);
    setSidebarToggleTop(nextTop);
    if (dragState.moved) {
      suppressSidebarToggleClickRef.current = true;
    }
    patchWorkspace((current) => (current.sidebarToggleTop === nextTop ? current : { ...current, sidebarToggleTop: nextTop }));
    sidebarToggleDragRef.current = null;
  }

  async function refreshProjectThreads(project: ProjectEntry): Promise<ListProjectSessionsResultPayload> {
    setProjectLoadingId(project.id);

    try {
      const result = await sendCommand('list-project-sessions', { cwd: project.cwd, maxSessions: 16 }, project.cliId);
      const payload = result.payload as ListProjectSessionsResultPayload | undefined;
      const normalizedPayload = payload ?? {
        cwd: project.cwd,
        label: project.label,
        sessions: []
      };

      patchWorkspace((current) => ({
        ...current,
        projects: current.projects.map((entry) =>
          entry.id !== project.id
            ? entry
            : {
                ...entry,
                cwd: normalizedPayload.cwd,
                label: normalizedPayload.label
              }
        )
      }));

      setProjectThreads(project.id, (threads) => mergeProjectThreads(threads, normalizedPayload.sessions));

      return normalizedPayload;
    } finally {
      setProjectLoadingId((current) => (current === project.id ? null : current));
    }
  }

  async function activateThread(project: ProjectEntry, thread: ProjectThreadEntry): Promise<void> {
    try {
      setError('');
      requestedThreadKeyRef.current = `${project.cliId}:${thread.threadKey}:${thread.sessionId ?? 'draft'}`;
      if (thread.sessionId === null) {
        setSnapshot(createEmptySnapshot());
        setOlderMessages([]);
        setHasOlderMessages(false);
      }
      patchWorkspace((current) => ({
        ...current,
        activeCliId: project.cliId,
        activeProjectId: project.id,
        activeThreadId: thread.id
      }));

      await sendCommand(
        'select-thread',
        {
          cwd: project.cwd,
          threadKey: thread.threadKey,
          sessionId: thread.sessionId
        },
        project.cliId
      );
      setMobilePane('chat');
    } catch (activateError) {
      requestedThreadKeyRef.current = null;
      setError(activateError instanceof Error ? activateError.message : '切换 thread 失败');
    }
  }

  async function handleAddProject() {
    try {
      setError('');
      const targetCliId = activeCliId ?? clis[0]?.cliId ?? null;
      if (!targetCliId) {
        throw new Error('请先选择一个在线 CLI');
      }

      const result = await sendCommand('pick-project-directory', {}, targetCliId);
      const payload = result.payload as PickProjectDirectoryResultPayload | undefined;
      if (!payload?.cwd) {
        return;
      }

      let selectedProject: ProjectEntry = {
        id: crypto.randomUUID(),
        cliId: targetCliId,
        cwd: payload.cwd,
        label: payload.label
      };

      patchWorkspace((current) => {
        const existingProject = current.projects.find((project) => project.cliId === targetCliId && project.cwd === payload.cwd);
        if (existingProject) {
          selectedProject = existingProject;
          return {
            ...current,
            activeCliId: existingProject.cliId,
            activeProjectId: existingProject.id,
            activeThreadId: current.activeThreadId
          };
        }

        return {
          ...current,
          activeCliId: targetCliId,
          activeProjectId: selectedProject.id,
          activeThreadId: null,
          projects: sortProjects([...current.projects, selectedProject])
        };
      });

      const history = await refreshProjectThreads(selectedProject);
      const draftThread = createDraftThread();
      const nextThreads = mergeProjectThreads(projectThreadsById[selectedProject.id] ?? [], history.sessions);
      const resolvedThreads = nextThreads.length > 0 ? nextThreads : [draftThread];
      const nextThread = resolvedThreads.find((thread) => thread.sessionId === history.sessions[0]?.sessionId) ?? resolvedThreads[0];
      setProjectThreads(selectedProject.id, () => resolvedThreads);

      if (nextThread) {
        await activateThread(selectedProject, nextThread);
      }
    } catch (addProjectError) {
      setError(addProjectError instanceof Error ? addProjectError.message : '添加项目失败');
    }
  }

  async function handleRefreshProject(project: ProjectEntry): Promise<void> {
    try {
      setError('');
      const history = await refreshProjectThreads(project);
      const nextThreads = mergeProjectThreads(projectThreadsById[project.id] ?? [], history.sessions);
      const activeCandidate =
        nextThreads.find((thread) => thread.id === workspaceState.activeThreadId) ??
        nextThreads.find((thread) => thread.sessionId === history.sessions[0]?.sessionId) ??
        nextThreads[0];

      patchWorkspace((current) => ({
        ...current,
        activeCliId: project.cliId,
        activeProjectId: project.id,
        activeThreadId: activeCandidate?.id ?? current.activeThreadId
      }));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '刷新项目历史失败');
    }
  }

  function handleCreateThread(projectId: string): void {
    const nextProject = workspaceState.projects.find((project) => project.id === projectId) ?? null;
    const nextThread = createDraftThread();
    setProjectThreads(projectId, (threads) => sortThreads([nextThread, ...threads]));
    patchWorkspace((current) => ({
      ...current,
      activeCliId: nextProject?.cliId ?? current.activeCliId,
      activeProjectId: projectId,
      activeThreadId: nextThread?.id ?? current.activeThreadId
    }));

    if (nextProject && nextThread) {
      void activateThread(nextProject, nextThread);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const content = prompt.trim();
    if (!content) {
      setError('请输入消息');
      return;
    }
    if (!activeProject || !activeThread) {
      setError('请先在侧边栏选择一个 project / thread');
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

  async function handleStop(): Promise<void> {
    try {
      setError('');
      await sendCommand('stop-message', {});
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : '结束失败');
    }
  }

  async function handleLoadOlderMessages() {
    try {
      setError('');
      setOlderMessagesLoading(true);
      if (messagesRef.current) {
        preserveMessagesScrollRef.current = {
          scrollHeight: messagesRef.current.scrollHeight,
          scrollTop: messagesRef.current.scrollTop
        };
      }

      const oldestMessageId = visibleMessages[0]?.id;
      const result = await sendCommand('get-older-messages', {
        beforeMessageId: oldestMessageId,
        maxMessages: 40
      });
      const payload = result.payload as GetOlderMessagesResultPayload | undefined;

      if ((payload?.threadKey ?? null) !== snapshot.threadKey) {
        preserveMessagesScrollRef.current = null;
        return;
      }

      if (!payload?.messages?.length) {
        preserveMessagesScrollRef.current = null;
      }

      setOlderMessages((current) => mergeChronologicalMessages(payload?.messages ?? [], current));
      setHasOlderMessages(Boolean(payload?.hasOlderMessages));
    } catch (loadError) {
      preserveMessagesScrollRef.current = null;
      setError(loadError instanceof Error ? loadError.message : '加载更早消息失败');
    } finally {
      setOlderMessagesLoading(false);
    }
  }

  return (
    <div className="h-dvh overflow-hidden bg-white text-zinc-900 lg:bg-zinc-100">
      <button
        type="button"
        onClick={handleOpenSidebarButtonClick}
        onPointerDown={handleSidebarTogglePointerDown}
        onPointerMove={handleSidebarTogglePointerMove}
        onPointerUp={handleSidebarTogglePointerRelease}
        onPointerCancel={handleSidebarTogglePointerRelease}
        className={[
          'fixed left-4 z-50 flex h-14 w-14 cursor-grab touch-none items-center justify-center rounded-[1.2rem] border border-zinc-200/90 bg-white/80 text-zinc-500 shadow-[0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur-sm transition duration-200 hover:bg-white/95 hover:text-zinc-700 hover:shadow-[0_14px_28px_rgba(0,0,0,0.1)] active:cursor-grabbing',
          workspaceState.sidebarCollapsed ? 'opacity-85' : 'pointer-events-none opacity-0'
        ].join(' ')}
        aria-label="打开边栏"
        title="打开边栏，支持上下拖动"
        style={{ top: sidebarToggleTop }}
      >
        <span className="relative block h-6 w-6 rounded-lg border border-current">
          <span className="absolute top-0 bottom-0 left-1/2 border-l border-current" />
        </span>
      </button>

      <div
        className={[
          'fixed inset-0 z-40 transition-opacity duration-300',
          workspaceState.sidebarCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
        ].join(' ')}
      >
        <button
          type="button"
          aria-label="关闭边栏蒙版"
          onClick={() => patchWorkspace((current) => ({ ...current, sidebarCollapsed: true }))}
          className={[
            'absolute inset-0 bg-black/18 backdrop-blur-[1px] transition-opacity duration-300',
            workspaceState.sidebarCollapsed ? 'opacity-0' : 'opacity-100'
          ].join(' ')}
        />

        <aside
          className={[
            'absolute top-0 left-0 flex h-full w-[22rem] max-w-[88vw] flex-col border-r border-zinc-200 bg-white shadow-[0_18px_60px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out',
            workspaceState.sidebarCollapsed ? '-translate-x-full' : 'translate-x-0'
          ].join(' ')}
        >
          <div className="flex-1 space-y-2.5 overflow-auto p-2.5 pt-3">
            {workspaceState.projects.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                先添加一个项目目录，再在目录下切换历史 thread 或创建新 thread。
              </div>
            ) : (
              workspaceState.projects.map((project) => {
                const isActiveProject = project.id === workspaceState.activeProjectId;
                const isLoading = projectLoadingId === project.id;
                const projectThreads = projectThreadsById[project.id] ?? [];
                const projectCli = clis.find((entry) => entry.cliId === project.cliId) ?? null;
                return (
                  <section
                    key={project.id}
                    className={[
                      'rounded-2xl border px-2.5 py-2.5 transition',
                      isActiveProject ? 'border-zinc-900 bg-zinc-950 text-white shadow-[0_10px_24px_rgba(0,0,0,0.12)]' : 'border-zinc-200 bg-transparent'
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          patchWorkspace((current) => ({
                            ...current,
                            activeCliId: project.cliId,
                            activeProjectId: project.id,
                            activeThreadId: projectThreads[0]?.id ?? current.activeThreadId
                          }))
                        }
                        className="min-w-0 text-left"
                      >
                        <div className="truncate text-[13px] font-semibold">{project.label}</div>
                        <div className={['mt-0.5 line-clamp-1 text-[11px]', isActiveProject ? 'text-zinc-300' : 'text-zinc-500'].join(' ')}>{project.cwd}</div>
                        <div className={['mt-0.5 text-[10px]', isActiveProject ? 'text-zinc-400' : 'text-zinc-500'].join(' ')}>
                          {projectCli?.label ?? project.cliId}
                        </div>
                      </button>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void handleRefreshProject(project);
                          }}
                          className={[
                            'flex h-8 w-8 items-center justify-center rounded-lg border transition',
                            isActiveProject ? 'border-white/10 text-white hover:bg-white/10' : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100'
                          ].join(' ')}
                          disabled={isLoading}
                          aria-label={isLoading ? '刷新中' : '刷新项目'}
                          title={isLoading ? '刷新中' : '刷新项目'}
                        >
                          <svg
                            viewBox="0 0 20 20"
                            fill="none"
                            aria-hidden="true"
                            className={['h-4 w-4', isLoading ? 'animate-spin' : ''].join(' ')}
                          >
                            <path
                              d="M16 10a6 6 0 1 1-1.66-4.14"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                            <path d="M16 4.5v3.8h-3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCreateThread(project.id)}
                          className={[
                            'flex h-8 w-8 items-center justify-center rounded-lg border transition',
                            isActiveProject ? 'border-sky-200 bg-sky-300 text-zinc-950 hover:bg-sky-200' : 'border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700'
                          ].join(' ')}
                          aria-label="新线程"
                          title="新线程"
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                            <path d="M10 4v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            <path d="M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 space-y-1">
                      {projectThreads.length === 0 ? (
                        <div className={['rounded-xl border px-2.5 py-2 text-[11px]', isActiveProject ? 'border-white/10 text-zinc-300' : 'border-zinc-200 text-zinc-500'].join(' ')}>
                          这个 project 还没有可用 thread。
                        </div>
                      ) : (
                        projectThreads.map((thread) => {
                          const isActiveThread = isActiveProject && thread.id === workspaceState.activeThreadId;
                          return (
                            <button
                              key={thread.id}
                              type="button"
                              onClick={() => {
                                void activateThread(project, thread);
                              }}
                              className={[
                                'block w-full rounded-xl border px-2.5 py-2 text-left transition',
                                isActiveThread
                                  ? isActiveProject
                                    ? 'border-white/10 bg-white/10 text-white'
                                    : 'border-sky-200 bg-sky-100 text-zinc-950'
                                  : isActiveProject
                                    ? 'border-transparent bg-transparent text-white hover:bg-white/6'
                                    : 'border-transparent bg-transparent text-zinc-800 hover:bg-zinc-100'
                              ].join(' ')}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-[13px] font-medium">{thread.title}</span>
                                <span className="shrink-0 text-[9px] uppercase tracking-[0.18em] opacity-70">{thread.draft ? 'draft' : 'resume'}</span>
                              </div>
                              <div className={['mt-0.5 line-clamp-1 text-[11px]', isActiveThread ? (isActiveProject ? 'text-zinc-100' : 'text-zinc-700') : isActiveProject ? 'text-zinc-300' : 'text-zinc-500'].join(' ')}>
                                {thread.preview}
                              </div>
                              <div className={['mt-1 text-[10px]', isActiveThread ? (isActiveProject ? 'text-zinc-300' : 'text-zinc-700') : isActiveProject ? 'text-zinc-400' : 'text-zinc-500'].join(' ')}>
                                {thread.sessionId ? thread.sessionId.slice(0, 8) : 'new'} · {new Date(thread.updatedAt).toLocaleString()}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </section>
                );
              })
            )}
          </div>

          <div className="border-t border-zinc-200 bg-white/95 px-3 py-3 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <select
                value={workspaceState.activeCliId ?? ''}
                onChange={(event) =>
                  patchWorkspace((current) => ({
                    ...current,
                    activeCliId: event.target.value || null,
                    activeProjectId:
                      current.activeProjectId &&
                      current.projects.find((project) => project.id === current.activeProjectId)?.cliId === (event.target.value || null)
                        ? current.activeProjectId
                        : current.projects.find((project) => project.cliId === (event.target.value || null))?.id ?? null,
                    activeThreadId: null
                  }))
                }
                className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700"
              >
                <option value="">选择 CLI</option>
                {clis.map((entry) => (
                  <option key={entry.cliId} value={entry.cliId}>
                    {entry.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => {
                  void handleAddProject();
                }}
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white transition hover:bg-zinc-700"
                aria-label="添加项目"
                title="添加项目"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>

              <button
                type="button"
                onClick={() => patchWorkspace((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-300 text-zinc-700 transition hover:bg-zinc-50"
                aria-label="收起边栏"
                title="收起边栏"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 4v12M12.5 7.5l-2 2.5 2 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </aside>
      </div>

      <div className="mx-auto flex h-full max-w-[1600px] flex-col gap-3 overflow-hidden px-0 pt-3 pb-0 md:gap-4 md:p-6">
        <main className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0 md:gap-4 md:pr-1">
            <header className="mx-4 rounded-3xl border border-zinc-200 bg-white px-4 py-3 shadow-sm lg:mx-0">
              <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap text-sm text-zinc-600 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                <span className="text-base font-semibold text-zinc-900">pty-remote</span>
                {headerSummary.map((item) => (
                  <span key={item} className="flex items-center gap-3">
                    <span className="text-zinc-300">/</span>
                    <span>{item}</span>
                  </span>
                ))}
              </div>
            </header>

            <nav className="mx-4 rounded-2xl border border-zinc-200 bg-white p-1 shadow-sm lg:hidden" aria-label="Mobile panels">
              <div className="grid grid-cols-2 gap-1">
                {(
                  [
                    ['chat', 'Chat'],
                    ['terminal', 'Terminal']
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

            <section className="min-h-0 flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-4">
              <div
                className={[
                  'min-h-0 min-w-0 flex-1 flex-col',
                  mobilePane === 'chat' ? 'flex' : 'hidden lg:flex'
                ].join(' ')}
              >
                <div className="relative flex min-h-[22rem] min-w-0 flex-1 flex-col overflow-hidden bg-transparent sm:min-h-[24rem] lg:min-h-[28rem] lg:rounded-3xl lg:border lg:border-zinc-200 lg:bg-white lg:shadow-sm">
                  <div className="hidden px-3 py-3 sm:px-4 lg:block lg:border-b lg:border-zinc-200">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold">Messages</h2>
                      </div>
                      {hasOlderMessages ? (
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
                  {hasOlderMessages ? (
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
                  <div ref={messagesRef} className="min-h-0 min-w-0 flex-1 space-y-2 overflow-auto px-1 py-4 sm:px-3 lg:px-4">
                    {renderableMessages.length === 0 ? null : (
                      renderableMessages.map((message) => (
                        <div
                          key={message.id}
                          ref={message.role === 'user' ? (node) => setQuestionMessageRef(message.id, node) : undefined}
                        >
                          <MessageShell message={message}>
                            <MessageContent message={message} toolCallIndex={toolCallIndex} />
                          </MessageShell>
                        </div>
                      ))
                    )}
                  </div>

                  {questionMessageIds.length > 0 ? (
                    <div className="pointer-events-none absolute right-4 bottom-4 z-10">
                      <div className="pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white/65 shadow-[0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur-sm">
                        <button
                          type="button"
                          onClick={() => handleQuestionJumpButtonClick('up')}
                          onDoubleClick={() => handleQuestionJumpButtonDoubleClick('up')}
                          className="flex h-10 w-10 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900"
                          aria-label="跳到上一条提问，双击直达顶部"
                          title="跳到上一条提问，双击直达顶部"
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                            <path d="M5 12l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <div className="h-px bg-zinc-200/80" />
                        <button
                          type="button"
                          onClick={() => handleQuestionJumpButtonClick('down')}
                          onDoubleClick={() => handleQuestionJumpButtonDoubleClick('down')}
                          className="flex h-10 w-10 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900"
                          aria-label="跳到下一条提问，双击直达底部"
                          title="跳到下一条提问，双击直达底部"
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                            <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div
                className={[
                  'relative flex min-h-[22rem] min-w-0 flex-1 flex-col overflow-hidden bg-transparent sm:min-h-[24rem] lg:min-h-[28rem] lg:rounded-3xl lg:border lg:border-zinc-200 lg:bg-white lg:shadow-sm',
                  mobilePane === 'terminal' ? 'flex' : 'hidden lg:flex'
                ].join(' ')}
              >
                <div className="hidden px-3 py-3 sm:px-4 lg:block lg:border-b lg:border-zinc-200">
                  <h2 className="text-lg font-semibold">Terminal</h2>
                </div>
                <div className="terminal-shell min-w-0 flex-1 overflow-hidden bg-transparent p-0 sm:p-2 lg:rounded-b-3xl lg:bg-white lg:p-3">
                  <div ref={terminalViewportRef} className="h-full overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x">
                    <div ref={terminalHostRef} className="h-full min-w-full overflow-hidden bg-transparent lg:bg-white" />
                  </div>
                </div>

                <div className="pointer-events-none absolute right-4 bottom-4 z-10">
                  <div className="pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white/65 shadow-[0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur-sm">
                    <button
                      type="button"
                      onClick={() => handleTerminalJumpToEdge('up')}
                      className="flex h-10 w-10 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900"
                      aria-label="终端直达顶部"
                      title="终端直达顶部"
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                        <path d="M5 12l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <div className="h-px bg-zinc-200/80" />
                    <button
                      type="button"
                      onClick={() => handleTerminalJumpToEdge('down')}
                      className="flex h-10 w-10 items-center justify-center text-zinc-600 transition hover:bg-white/80 hover:text-zinc-900"
                      aria-label="终端直达底部"
                      title="终端直达底部"
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                        <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <form onSubmit={handleSubmit} className="shrink-0 px-1 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:-mx-6 md:-mb-6 md:px-3 md:py-2 md:pb-2">
            <div className="mb-1.5 flex flex-wrap gap-2 text-xs font-medium">
              <span className="rounded-full bg-zinc-900 px-3 py-1 text-white">socket: {socketConnected ? 'online' : 'offline'}</span>
              <span className={['rounded-full px-3 py-1', statusBadgeClassName].join(' ')}>status: {headerText}</span>
            </div>

            <div className="relative">
              <input
                type="text"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  !activeProject
                    ? '先从左侧添加并选择一个 project / thread。'
                    : !connected
                      ? '等待 CLI 连接...'
                      : snapshot.status === 'starting'
                        ? 'Claude 正在启动...'
                        : snapshot.status === 'running'
                          ? 'Claude 正在运行...'
                          : snapshot.status === 'error'
                            ? '上次运行出错，可继续输入或切到别的 thread。'
                            : activeThread?.draft
                              ? '这是一个新 thread，第一条消息会创建新 session。'
                              : '输入消息，继续这个 thread。'
                }
                className="h-14 w-full rounded-xl border border-zinc-300 bg-white px-5 pr-28 text-sm outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-500"
                disabled={!canSend}
              />
              <button
                type={busy ? 'button' : 'submit'}
                onClick={busy ? () => void handleStop() : undefined}
                className="absolute top-1/2 right-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy ? !canStop : !canSend}
                aria-label={busy ? '结束当前运行' : '发送消息'}
                title={busy ? '结束当前运行' : '发送消息'}
              >
                {busy ? (
                  <span className="block h-3.5 w-3.5 rounded-[0.2rem] bg-current" aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                    <path d="M10 14V6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M6.5 9.5 10 6l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </div>

            <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-300 bg-white text-xs font-medium text-zinc-700 transition hover:bg-zinc-50"
                  aria-label="Slash tool"
                  title="Slash tool"
                >
                  /
                </button>
              </div>
              <div className="text-sm text-red-600 sm:text-right">{footerErrorText}</div>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}
