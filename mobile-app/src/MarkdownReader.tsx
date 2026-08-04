import { createElement, isValidElement, memo, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ImageOff } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import katexStyles from 'katex/dist/katex.min.css?inline'
import MermaidDiagram from './MermaidDiagram'
import rehypeCodeHighlight from './rehype-code-highlight'
import remarkDisplayMath from './remark-display-math'
import remarkReferenceBreaks from './remark-reference-breaks'
import type { ThemeMode } from './reader-settings'
import { buildRenderPlan, createRenderPlan, reconcileRenderPlans } from './render-plan'
import type { RenderBlock, RenderPlan } from './render-plan'

type MarkdownReaderProps = {
  content: string
  documentPath?: string
  resources?: Record<string, string>
  contentRef: React.RefObject<HTMLElement | null>
  themeMode: ThemeMode
  onOpenExternalLink?: (url: string) => void
  searchQuery?: string
  forceHeadingId?: string
  onPlanReady?: (plan: RenderPlan) => void
  onRenderChange?: () => void
}

const PROGRESSIVE_THRESHOLD = 1024 * 1024

function MarkdownReader({ content, documentPath, resources, contentRef, themeMode, onOpenExternalLink, searchQuery = '', forceHeadingId, onPlanReady, onRenderChange }: MarkdownReaderProps) {
  const [asyncPlan, setAsyncPlan] = useState<RenderPlan | null>(null)
  const lastCompletedPlanRef = useRef<RenderPlan | null>(null)
  const immediatePlan = useMemo(() => content.length < PROGRESSIVE_THRESHOLD ? createRenderPlan(content) : null, [content])
  const previewPlan = useMemo(
    () => content.length >= PROGRESSIVE_THRESHOLD ? createRenderPlan(content.slice(0, 128 * 1024)) : null,
    [content],
  )
  const completedPlan = immediatePlan ?? asyncPlan
  const plan = completedPlan ?? previewPlan
  useEffect(() => {
    if (immediatePlan) {
      setAsyncPlan(null)
      return undefined
    }
    let cancelled = false
    void buildRenderPlan(content).then((result) => {
      if (!cancelled) {
        const reconciled = reconcileRenderPlans(lastCompletedPlanRef.current, result)
        lastCompletedPlanRef.current = reconciled
        setAsyncPlan(reconciled)
      }
    })
    return () => { cancelled = true }
  }, [content, immediatePlan])
  useEffect(() => {
    if (completedPlan) {
      lastCompletedPlanRef.current = completedPlan
      onPlanReady?.(completedPlan)
    }
  }, [completedPlan, onPlanReady])

  const components = useMemo(
    () => createMarkdownComponents(documentPath, resources, themeMode, onOpenExternalLink),
    // Content changes intentionally reset the per-render duplicate-heading counters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, documentPath, resources, themeMode, onOpenExternalLink],
  )
  if (!plan) return <article className="reader-content markdown-body" ref={contentRef}>正在生成大文档阅读视图...</article>
  if (content.length >= PROGRESSIVE_THRESHOLD) {
    return (
      <article className="reader-content markdown-body progressive-markdown" ref={contentRef} data-render-revision={plan.revision}>
        <style data-search-exclude="true">{katexStyles}</style>
        {plan.blocks.map((block, index) => (
          <ProgressiveBlock
            key={block.id}
            block={block}
            initiallyVisible={index < 12}
            forced={Boolean(
              (forceHeadingId && block.headingIds.includes(forceHeadingId))
              || (searchQuery && block.plainText.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())),
            )}
            documentPath={documentPath}
            resources={resources}
            themeMode={themeMode}
            onOpenExternalLink={onOpenExternalLink}
            onRenderChange={onRenderChange}
          />
        ))}
      </article>
    )
  }
  return (
    <article className="reader-content markdown-body" ref={contentRef}>
      <style data-search-exclude="true">{katexStyles}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }], remarkDisplayMath, remarkReferenceBreaks]}
        rehypePlugins={[rehypeCodeHighlight, [rehypeKatex, { throwOnError: false, trust: false }]]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {content}
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
    && previous.onPlanReady === next.onPlanReady
    && previous.onRenderChange === next.onRenderChange
  if (!sharedPropsEqual) return false
  if (next.content.length < PROGRESSIVE_THRESHOLD) return true
  return previous.searchQuery === next.searchQuery && previous.forceHeadingId === next.forceHeadingId
})

function createMarkdownComponents(
  documentPath?: string,
  resources?: Record<string, string>,
  themeMode: ThemeMode = 'light',
  onOpenExternalLink?: (url: string) => void,
  initialHeadingCounts: Record<string, number> = {},
): Components {
  const used = new Map<string, number>(Object.entries(initialHeadingCounts))
  const documentDir = dirname(documentPath ?? '')
  const resolveResource = (src: string) => {
    if (!resources) return src
    return resources[normalizeArchiveResourcePath(documentDir, src)] ?? src
  }

  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => {
    const tagName = `h${level}`
    return function Heading({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
      const text = childrenToText(children)
      const baseId = slugify(text)
      const count = used.get(baseId) ?? 0
      used.set(baseId, count + 1)
      const id = count ? `${baseId}-${count}` : baseId
      return createElement(tagName, { id, ...props }, children)
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
        return <MermaidDiagram source={String(children).replace(/\n$/, '')} themeMode={themeMode} />
      }
      return <code className={className} {...props}>{children}</code>
    },
    a({ children, href }) {
      const external = Boolean(href && /^https?:\/\//i.test(href))
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={external && onOpenExternalLink ? (event) => {
            event.preventDefault()
            onOpenExternalLink(href ?? '')
          } : undefined}
        >
          {children}
        </a>
      )
    },
    img({ alt, src }) {
      const resolvedSrc = resolveResource(src ?? '')
      return <ImgWithFallback key={resolvedSrc} src={resolvedSrc} alt={alt ?? ''} />
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
  documentPath,
  resources,
  themeMode,
  onOpenExternalLink,
  onRenderChange,
}: {
  block: RenderBlock
  initiallyVisible: boolean
  forced: boolean
  documentPath?: string
  resources?: Record<string, string>
  themeMode: ThemeMode
  onOpenExternalLink?: (url: string) => void
  onRenderChange?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(initiallyVisible || forced)
  const [height, setHeight] = useState(block.estimatedHeight)
  const keepAliveAfterMount = /```\s*mermaid\b/i.test(block.source)
  const components = useMemo(
    () => createMarkdownComponents(documentPath, resources, themeMode, onOpenExternalLink, block.headingCountsBefore),
    [block.headingCountsBefore, documentPath, onOpenExternalLink, resources, themeMode],
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
      style={visible ? undefined : { minHeight: `${height}px` }}
    >
      {visible && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }], remarkDisplayMath, remarkReferenceBreaks]}
          rehypePlugins={[rehypeCodeHighlight, [rehypeKatex, { throwOnError: false, trust: false }]]}
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
  && previous.initiallyVisible === next.initiallyVisible
  && previous.documentPath === next.documentPath
  && previous.resources === next.resources
  && previous.themeMode === next.themeMode
  && previous.onOpenExternalLink === next.onOpenExternalLink
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

function slugify(text: string) {
  return text.toLowerCase().replace(/[`*_~()[\]{}:;'"，。！？、]/g, '').trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'heading'
}

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(children)) return childrenToText(children.props.children)
  return ''
}
