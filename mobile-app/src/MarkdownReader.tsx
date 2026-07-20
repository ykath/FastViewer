import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ImageOff } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeCodeHighlight from './rehype-code-highlight'

type MarkdownReaderProps = {
  content: string
  documentPath?: string
  resources?: Record<string, string>
  contentRef: React.RefObject<HTMLElement | null>
}

export default function MarkdownReader({ content, documentPath, resources, contentRef }: MarkdownReaderProps) {
  const components = useMemo(
    () => createMarkdownComponents(documentPath, resources),
    [documentPath, resources],
  )
  return (
    <article className="reader-content markdown-body" ref={contentRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCodeHighlight]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}

function createMarkdownComponents(documentPath?: string, resources?: Record<string, string>): Components {
  const used = new Map<string, number>()
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
    a({ children, href }) {
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>
    },
    img({ alt, src }) {
      return <ImgWithFallback src={resolveResource(src ?? '')} alt={alt ?? ''} />
    },
    li({ children, ...props }) {
      const hasCheckbox = Array.isArray(children) && children.some(
        (child) => typeof child === 'object' && child !== null && 'type' in child && child.type === 'input',
      )
      return <li className={hasCheckbox ? 'task-list-item' : undefined} {...props}>{children}</li>
    },
  }
}

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
  return ''
}
