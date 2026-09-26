import { createElement, isValidElement, memo, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ImageOff } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import type { ExtraProps } from 'react-markdown'
import type { Element } from 'hast'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import katexStyles from 'katex/dist/katex.min.css?inline'
import MermaidDiagram from './MermaidDiagram'
import rehypeCodeHighlight from './rehype-code-highlight'
import remarkDisplayMath from './remark-display-math'
import remarkReferenceBreaks from './remark-reference-breaks'
import remarkVideo, { markdownVideoHandler } from './remark-video'
import { defaultHandlers } from 'mdast-util-to-hast'
import type { PluggableList } from 'unified'
import MarkdownVideo from './MarkdownVideo'
import { isVideoPath, normalizeMarkdownVideoHtml, parseMarkdownVideoPayload } from './markdown-media'
import type { ThemeMode } from './reader-settings'
import { buildRenderPlan, createRenderPlan, reconcileRenderPlans } from './render-plan'
import type { RenderBlock, RenderPlan } from './render-plan'
import { allocateMarkdownHeadingId, classifyMarkdownLink } from './html-processing'
import { contentRenderRevision } from './render-revision'

type MarkdownReaderProps = {
  content: string
  documentPath?: string
  resources?: Record<string, string>
  contentRef: React.RefObject<HTMLElement | null>
  themeMode: ThemeMode
  onOpenExternalLink?: (url: string) => void
  onOpenDocumentLink?: (href: string) => void
  searchQuery?: string
  forceHeadingId?: string
  renderAll?: boolean
  onPlanReady?: (plan: RenderPlan) => void
  onRenderChange?: () => void
}

const PROGRESSIVE_THRESHOLD = 1024 * 1024
const remarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: true }], remarkDisplayMath, remarkReferenceBreaks, remarkVideo]
const rehypeHeadingIds = (initialCounts: Record<string, number> = {}) => () => (tree: HastNode) => {
  const used = new Map<string, number>(Object.entries(initialCounts))
  walkHeadingIds(tree, used)
}

const remarkRehypeOptions = {
  handlers: {
    ...defaultHandlers,
    markdownVideo: markdownVideoHandler,
  },
} as import('remark-rehype').Options

function MarkdownReader({ content, documentPath, resources, contentRef, themeMode, onOpenExternalLink, onOpenDocumentLink, searchQuery = '', forceHeadingId, renderAll = false, onPlanReady, onRenderChange }: MarkdownReaderProps) {
  const renderContent = useMemo(() => normalizeMarkdownVideoHtml(content), [content])
  const [asyncPlan, setAsyncPlan] = useState<RenderPlan | null>(null)
  const lastCompletedPlanRef = useRef<RenderPlan | null>(null)
  const renderRevision = useMemo(() => contentRenderRevision(renderContent), [renderContent])
  const immediatePlan = useMemo(() => renderContent.length < PROGRESSIVE_THRESHOLD ? createRenderPlan(renderContent) : null, [renderContent])
  const previewPlan = useMemo(
    () => renderContent.length >= PROGRESSIVE_THRESHOLD ? createRenderPlan(renderContent.slice(0, 128 * 1024)) : null,
    [renderContent],
  )
  const completedPlan = immediatePlan ?? asyncPlan
  const plan = completedPlan ?? previewPlan
  useEffect(() => {
    if (immediatePlan) {
      setAsyncPlan(null)
      return undefined
    }
    let cancelled = false
    void buildRenderPlan(renderContent).then((result) => {
      if (!cancelled) {
        const reconciled = reconcileRenderPlans(lastCompletedPlanRef.current, result)
        lastCompletedPlanRef.current = reconciled
        setAsyncPlan(reconciled)
      }
    })
    return () => { cancelled = true }
  }, [renderContent, immediatePlan])
  useEffect(() => {
    if (completedPlan) {
      lastCompletedPlanRef.current = completedPlan
      onPlanReady?.(completedPlan)
    }
  }, [completedPlan, onPlanReady])

  const externalLinkRef = useRef(onOpenExternalLink)
  const documentLinkRef = useRef(onOpenDocumentLink)
  const headingCountsRef = useRef(new Map<string, number>())
  /* eslint-disable react-hooks/refs -- 写入最新回调且不重建组件表，避免视频在滚动时被卸载 */
  externalLinkRef.current = onOpenExternalLink
  documentLinkRef.current = onOpenDocumentLink
  headingCountsRef.current = new Map()
  const components = useMemo(
    () => createMarkdownComponents(
      documentPath,
      resources,
      themeMode,
      headingCountsRef,
      (url) => externalLinkRef.current?.(url),
      (href) => documentLinkRef.current?.(href),
      renderAll,
    ),
  /* eslint-enable react-hooks/refs */
    // Callback identity must not rebuild the component map, or <video> remounts while scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderContent, documentPath, resources, themeMode, renderAll],
  )
  if (!plan) return <article key={renderRevision} className="reader-content markdown-body" ref={contentRef}>正在生成大文档阅读视图...</article>
  if (renderContent.length >= PROGRESSIVE_THRESHOLD) {
    return (
      <article
        key={renderRevision}
        className="reader-content markdown-body progressive-markdown"
        ref={contentRef}
        data-render-revision={plan.revision}
        data-render-complete={completedPlan ? 'true' : 'false'}
      >
        <style data-search-exclude="true">{katexStyles}</style>
        {plan.blocks.map((block, index) => (
          <ProgressiveBlock
            key={block.id}
            block={block}
            initiallyVisible={index < 12}
            forced={Boolean(
              renderAll
              || (forceHeadingId && block.headingIds.includes(forceHeadingId))
              || (searchQuery && block.plainText.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())),
            )}
            eagerMermaid={renderAll}
            documentPath={documentPath}
            resources={resources}
            themeMode={themeMode}
            onOpenExternalLink={onOpenExternalLink}
            onOpenDocumentLink={onOpenDocumentLink}
            onRenderChange={onRenderChange}
          />
        ))}
      </article>
    )
  }
  return (
    <article key={renderRevision} className="reader-content markdown-body" ref={contentRef}>
      <style data-search-exclude="true">{katexStyles}</style>
      <ReactMarkdown
        remarkPlugins={[...remarkPlugins]}
        remarkRehypeOptions={remarkRehypeOptions}
        rehypePlugins={[rehypeCodeHighlight, [rehypeKatex, { throwOnError: false, trust: false }], rehypeHeadingIds()]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {renderContent}
      </ReactMarkdown>
    </article>
  )
}

export default memo(MarkdownReader, (previous, next) => {
  const sharedPropsEqual = previous.content === next.content
    && previous.documentPath === next.documentPath
    && previous.resources === next.resources
    && previous.contentRef === next.contentRef
    && previous.themeMode === next.themeMode
    && previous.onOpenExternalLink === next.onOpenExternalLink
    && previous.onOpenDocumentLink === next.onOpenDocumentLink
    && previous.renderAll === next.renderAll
    && previous.onPlanReady === next.onPlanReady
    && previous.onRenderChange === next.onRenderChange
  if (!sharedPropsEqual) return false
  if (next.content.length < PROGRESSIVE_THRESHOLD) return true
  return previous.searchQuery === next.searchQuery && previous.forceHeadingId === next.forceHeadingId
})

function createMarkdownComponents(
  documentPath: string | undefined,
  resources: Record<string, string> | undefined,
  themeMode: ThemeMode,
  headingCountsRef: { current: Map<string, number> },
  onOpenExternalLink?: (url: string) => void,
  onOpenDocumentLink?: (href: string) => void,
  eagerMermaid = false,
): Components {
  const documentDir = dirname(documentPath ?? '')
  const resolveResource = (src: string) => {
    if (!resources) return src
    return resources[normalizeArchiveResourcePath(documentDir, src)] ?? src
  }

  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => {
    const tagName = `h${level}`
    return function Heading({ children, node, ...props }: React.HTMLAttributes<HTMLHeadingElement> & ExtraProps) {
      const pluginId = node?.properties?.id
      const id = typeof pluginId === 'string'
        ? pluginId
        : allocateMarkdownHeadingId(headingCountsRef.current, childrenToText(children))
      return createElement(tagName, { ...props, id }, children)
    }
  }

  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    table({ children }) {
      return <ScrollableTableWrap>{children}</ScrollableTableWrap>
    },
    pre({ children }) {
      return isValidElement(children) && children.type === MermaidDiagram ? children : <pre>{children}</pre>
    },
    code({ children, className, ...props }) {
      const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? '')?.[1]?.toLowerCase()
      if (language === 'mermaid') {
        return <MermaidDiagram source={String(children).replace(/\n$/, '')} themeMode={themeMode} eager={eagerMermaid} />
      }
      return <code className={className} {...props}>{children}</code>
    },
    a({ children, href }) {
      const linkKind = classifyMarkdownLink(href)
      const external = linkKind === 'external'
      const documentLink = linkKind === 'document'
      return (
        <a
          href={href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          onClick={(event) => {
            if (external && onOpenExternalLink) {
              event.preventDefault()
              onOpenExternalLink(href ?? '')
              return
            }
            if (documentLink && onOpenDocumentLink) {
              event.preventDefault()
              onOpenDocumentLink(href ?? '')
            }
          }}
        >
          {children}
        </a>
      )
    },
    img({ alt, src }) {
      const rawSrc = src ?? ''
      if (isVideoPath(rawSrc)) {
        return (
          <MarkdownVideo
            key={rawSrc}
            payload={{ variant: 'file', sources: [{ src: rawSrc }], controls: true, label: alt || undefined }}
            resolveSrc={resolveResource}
          />
        )
      }
      const resolvedSrc = resolveResource(rawSrc)
      return <ImgWithFallback key={resolvedSrc} src={resolvedSrc} alt={alt ?? ''} />
    },
    div({ node, className, children, ...props }: React.ComponentProps<'div'> & ExtraProps) {
      const property = (node as Element | undefined)?.properties?.dataLpVideo
      const rawPayload = typeof property === 'string' ? property : Array.isArray(property) ? property[0] : undefined
      const payload = parseMarkdownVideoPayload(rawPayload)
      if (payload) {
        return <MarkdownVideo payload={payload} resolveSrc={resolveResource} />
      }
      return <div className={className} {...props}>{children}</div>
    },
    li({ children, ...props }) {
      const hasCheckbox = Array.isArray(children) && children.some(
        (child) => typeof child === 'object' && child !== null && 'type' in child && child.type === 'input',
      )
      return <li className={hasCheckbox ? 'task-list-item' : undefined} {...props}>{children}</li>
    },
  }
}

const ProgressiveBlock = memo(function ProgressiveBlock({
  block,
  initiallyVisible,
  forced,
  eagerMermaid,
  documentPath,
  resources,
  themeMode,
  onOpenExternalLink,
  onOpenDocumentLink,
  onRenderChange,
}: {
  block: RenderBlock
  initiallyVisible: boolean
  forced: boolean
  eagerMermaid: boolean
  documentPath?: string
  resources?: Record<string, string>
  themeMode: ThemeMode
  onOpenExternalLink?: (url: string) => void
  onOpenDocumentLink?: (href: string) => void
  onRenderChange?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const externalLinkRef = useRef(onOpenExternalLink)
  const documentLinkRef = useRef(onOpenDocumentLink)
  const headingCountsRef = useRef(new Map<string, number>())
  /* eslint-disable react-hooks/refs -- 写入最新回调且不重建组件表，避免视频在滚动时被卸载 */
  externalLinkRef.current = onOpenExternalLink
  documentLinkRef.current = onOpenDocumentLink
  headingCountsRef.current = new Map(Object.entries(block.headingCountsBefore))
  const [visible, setVisible] = useState(initiallyVisible || forced)
  const [height, setHeight] = useState(block.estimatedHeight)
  const keepAliveAfterMount = /```\s*mermaid\b/i.test(block.source)
  const components = useMemo(
    () => createMarkdownComponents(
      documentPath,
      resources,
      themeMode,
      headingCountsRef,
      (url) => externalLinkRef.current?.(url),
      (href) => documentLinkRef.current?.(href),
      eagerMermaid,
    ),
    /* eslint-enable react-hooks/refs */
    [documentPath, eagerMermaid, resources, themeMode],
  )

  useEffect(() => {
    if (forced) setVisible(true)
  }, [forced])

  useEffect(() => {
    if (!visible) return undefined
    const frame = window.requestAnimationFrame(() => onRenderChange?.())
    return () => window.cancelAnimationFrame(frame)
  }, [onRenderChange, visible])

  useEffect(() => {
    const element = hostRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible((current) => entry.isIntersecting || forced || (keepAliveAfterMount && current))
    }, { rootMargin: '300% 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [forced, keepAliveAfterMount])

  useEffect(() => {
    const element = hostRef.current
    if (!element || !visible || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setHeight(entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  return (
    <div
      ref={hostRef}
      className="render-block"
      data-render-block={block.id}
      data-text-start={block.textStart}
      data-text-end={block.textEnd}
      data-rich-copy-ready={visible ? 'true' : 'false'}
      style={visible ? undefined : { minHeight: `${height}px` }}
    >
      {visible && (
        <ReactMarkdown
          remarkPlugins={[...remarkPlugins]}
          remarkRehypeOptions={remarkRehypeOptions}
          rehypePlugins={[rehypeCodeHighlight, [rehypeKatex, { throwOnError: false, trust: false }], rehypeHeadingIds(block.headingCountsBefore)]}
          components={components}
          urlTransform={markdownUrlTransform}
        >
          {block.source}
        </ReactMarkdown>
      )}
    </div>
  )
}, (previous, next) => previous.block.revision === next.block.revision
  && previous.block.id === next.block.id
  && previous.forced === next.forced
  && previous.eagerMermaid === next.eagerMermaid
  && previous.initiallyVisible === next.initiallyVisible
  && previous.documentPath === next.documentPath
  && previous.resources === next.resources
  && previous.themeMode === next.themeMode
  && previous.onOpenExternalLink === next.onOpenExternalLink
  && previous.onOpenDocumentLink === next.onOpenDocumentLink
  && previous.onRenderChange === next.onRenderChange)

function ScrollableTableWrap({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrollable, setScrollable] = useState(false)

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return undefined
    let frameId: number | null = null
    const check = () => {
      frameId = null
      setScrollable(element.scrollLeft + element.clientWidth < element.scrollWidth - 2)
    }
    const scheduleCheck = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(check)
    }
    scheduleCheck()
    const observer = new ResizeObserver(scheduleCheck)
    observer.observe(element)
    element.addEventListener('scroll', scheduleCheck, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', scheduleCheck)
      if (frameId !== null) window.cancelAnimationFrame(frameId)
    }
  }, [])

  return (
    <div ref={wrapRef} className={`markdown-table-wrap${scrollable ? ' scrollable' : ''}`}>
      <table>{children}</table>
    </div>
  )
}

function ImgWithFallback({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <span className="img-fallback"><ImageOff size={20} /><span>{alt || '图片加载失败'}</span></span>
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
}

function markdownUrlTransform(value: string) {
  return /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i.test(value)
    ? value
    : defaultUrlTransform(value)
}

function normalizeArchiveResourcePath(documentDir: string, resourcePath: string) {
  const [pathOnly] = resourcePath.split(/[?#]/, 1)
  let decoded = pathOnly
  try { decoded = decodeURIComponent(pathOnly) } catch { /* Keep the original path. */ }
  const parts = `${documentDir}/${decoded}`.replace(/\\/g, '/').split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return normalized.join('/').toLowerCase()
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : ''
}

type HastNode = {
  type?: string
  tagName?: string
  value?: string
  children?: HastNode[]
  properties?: Record<string, unknown>
}

function walkHeadingIds(node: HastNode, used: Map<string, number>) {
  if (node.type === 'element' && node.tagName && /^h[1-6]$/.test(node.tagName)) {
    node.properties = { ...node.properties, id: allocateMarkdownHeadingId(used, hastText(node)) }
  }
  node.children?.forEach((child) => walkHeadingIds(child, used))
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(children)) return childrenToText(children.props.children)
  return ''
}
