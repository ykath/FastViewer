import { Check, Copy, Maximize2, Minus, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import type { MermaidConfig, RenderResult } from 'mermaid'
import type { ThemeMode } from './reader-settings'
import { readSvgDimensions } from './mermaid-image'

type MermaidDiagramProps = {
  source: string
  themeMode: ThemeMode
}

type DiagramState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string }

let renderQueue: Promise<void> = Promise.resolve()

export default function MermaidDiagram({ source, themeMode }: MermaidDiagramProps) {
  const reactId = useId()
  const figureRef = useRef<HTMLElement>(null)
  const renderHostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<DiagramState>({ status: 'loading' })
  const [eligible, setEligible] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const diagramId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    const figure = figureRef.current
    if (!figure || typeof IntersectionObserver === 'undefined') {
      setEligible(true)
      return undefined
    }
    const markEligible = () => {
      const bounds = figure.getBoundingClientRect()
      const reader = figure.closest<HTMLElement>('.page-reader')
      const viewport = reader?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
      if (bounds.bottom >= viewport.top - 800 && bounds.top <= viewport.bottom + 800) setEligible(true)
    }
    const reader = figure.closest<HTMLElement>('.page-reader')
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setEligible(true)
        observer.disconnect()
      }
    }, { root: reader ?? null, rootMargin: '800px 0px' })
    observer.observe(figure)
    reader?.addEventListener('scroll', markEligible, { passive: true })
    window.addEventListener('scroll', markEligible, { passive: true })
    window.addEventListener('resize', markEligible)
    const frame = window.requestAnimationFrame(markEligible)
    // WebView2 may skip intersection callbacks for a subtree attached during the
    // same layout pass. Never leave a valid diagram as a permanent placeholder.
    const fallback = window.setTimeout(() => setEligible(true), 1_000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(fallback)
      observer.disconnect()
      reader?.removeEventListener('scroll', markEligible)
      window.removeEventListener('scroll', markEligible)
      window.removeEventListener('resize', markEligible)
    }
  }, [])

  useEffect(() => {
    if (!eligible) return undefined
    let cancelled = false
    const renderHost = renderHostRef.current
    setState({ status: 'loading' })

    const renderTask = renderQueue.then(async () => {
      if (!renderHost || cancelled) return
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize(createMermaidConfig(themeMode))
        const result: RenderResult = await mermaid.render(diagramId, source, renderHost)
        if (!cancelled) setState({ status: 'ready', svg: result.svg })
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : '无法解析 Mermaid 图表',
          })
        }
      } finally {
        renderHost.replaceChildren()
      }
    })

    renderQueue = renderTask.catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [diagramId, eligible, source, themeMode])

  const openViewer = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (document.documentElement.dataset.runtime !== 'desktop') return
    setViewerOpen(true)
  }

  return (<>
    <figure ref={figureRef} className="mermaid-diagram" data-search-exclude="true">
      <div ref={renderHostRef} className="mermaid-render-host" aria-hidden="true" />
      {!eligible && <div className="mermaid-status" role="status">流程图将在接近视口时绘制</div>}
      {eligible && state.status === 'loading' && (
        <div className="mermaid-status" role="status">正在绘制流程图...</div>
      )}
      {state.status === 'ready' && (
        <div
          className="mermaid-svg"
          role="img"
          aria-label="Mermaid 流程图"
          title="双击放大查看"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={openViewer}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      {state.status === 'error' && (
        <div className="mermaid-error" role="alert">
          <strong>流程图绘制失败</strong>
          <span>{state.message}</span>
          <pre><code>{source}</code></pre>
        </div>
      )}
    </figure>
    {viewerOpen && state.status === 'ready' && createPortal(
      <MermaidZoomViewer svg={state.svg} onClose={() => setViewerOpen(false)} />,
      document.body,
    )}
  </>)
}

function MermaidZoomViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const viewerId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const viewerSvg = useMemo(() => namespaceSvg(svg, `zoom-${viewerId}-`), [svg, viewerId])
  const aspectRatio = useMemo(() => readSvgAspectRatio(svg), [svg])
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 720 : window.innerHeight,
  }))
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [copyError, setCopyError] = useState('')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef({ active: false, pointerId: -1, startX: 0, startY: 0, originX: 0, originY: 0 })
  const fitSize = useMemo(
    () => fitSvgIntoViewport(aspectRatio, viewport.width, viewport.height),
    [aspectRatio, viewport.height, viewport.width],
  )

  const copyDiagramImage = useCallback(async () => {
    if (copyState === 'copying') return
    setCopyState('copying')
    setCopyError('')
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('当前系统不支持复制图像')
      }
      const background = getComputedStyle(document.documentElement)
        .getPropertyValue('--surface-muted')
        .trim() || '#ffffff'
      const png = await renderSvgToPngBlob(viewerSvg, background)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1800)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : '未知错误')
      setCopyState('error')
      window.setTimeout(() => setCopyState('idle'), 2400)
    }
  }, [copyState, viewerSvg])

  useEffect(() => {
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void copyDiagramImage()
        return
      }
      if ((event.key === '+' || event.key === '=') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setScale((value) => clampScale(value + 0.25))
      }
      if (event.key === '-' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setScale((value) => clampScale(value - 0.25))
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [copyDiagramImage, onClose])

  useEffect(() => {
    const handleResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const resetView = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return
    dragRef.current.active = false
    setDragging(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      className="mermaid-zoom-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid 大图查看器"
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header className="mermaid-zoom-toolbar">
        <strong>流程图查看器</strong>
        <div className="mermaid-zoom-actions" aria-label="缩放操作">
          <button type="button" onClick={() => setScale((value) => clampScale(value - 0.25))} aria-label="缩小流程图"><Minus size={17} /></button>
          <output aria-label="当前缩放比例">{Math.round(scale * 100)}%</output>
          <button type="button" onClick={() => setScale((value) => clampScale(value + 0.25))} aria-label="放大流程图"><Plus size={17} /></button>
          <button type="button" onClick={resetView}><Maximize2 size={16} />适应窗口</button>
          <button
            type="button"
            className={copyState === 'copied' ? 'success' : ''}
            disabled={copyState === 'copying'}
            onClick={() => { void copyDiagramImage() }}
            aria-label="复制流程图图像"
          >
            {copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}
            {copyState === 'copying' ? '复制中...' : copyState === 'copied' ? '已复制' : '复制图像'}
          </button>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭流程图查看器"><X size={18} /></button>
        </div>
      </header>
      <div
        className={`mermaid-zoom-canvas${dragging ? ' dragging' : ''}`}
        onWheel={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setScale((value) => clampScale(value * Math.exp(-event.deltaY * 0.0015)))
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          dragRef.current = {
            active: true,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag.active || drag.pointerId !== event.pointerId) return
          setOffset({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY })
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div
          className="mermaid-zoom-image"
          role="img"
          aria-label="放大的 Mermaid 流程图"
          style={{
            width: `${fitSize.width}px`,
            height: `${fitSize.height}px`,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: viewerSvg }}
        />
      </div>
      <p className={`mermaid-zoom-help${copyState === 'error' ? ' error' : ''}`}>
        {copyState === 'error' ? `复制失败：${copyError || '请检查 Windows 剪贴板权限后重试'}` : '滚轮缩放 · 拖动平移 · Ctrl+C 复制图像 · Esc 关闭'}
      </p>
    </div>
  )
}

async function renderSvgToPngBlob(svg: string, background: string) {
  const parser = new DOMParser()
  const svgDocument = parser.parseFromString(svg, 'image/svg+xml')
  const root = svgDocument.documentElement
  if (root.nodeName.toLowerCase() === 'parsererror') throw new Error('无法解析流程图图像')
  replaceForeignObjectLabels(svgDocument)

  const { width, height } = readSvgDimensions(svg)
  const maxDimensionScale = 4096 / Math.max(width, height)
  const maxPixelScale = Math.sqrt(12_000_000 / (width * height))
  const scale = Math.max(0.1, Math.min(2, maxDimensionScale, maxPixelScale))
  const outputWidth = Math.max(1, Math.round(width * scale))
  const outputHeight = Math.max(1, Math.round(height * scale))
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  root.setAttribute('width', String(outputWidth))
  root.setAttribute('height', String(outputHeight))

  const serialized = new XMLSerializer().serializeToString(root)
  const objectUrl = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await loadClipboardImage(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width = outputWidth
    canvas.height = outputHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建图像画布')
    context.fillStyle = background
    context.fillRect(0, 0, outputWidth, outputHeight)
    context.drawImage(image, 0, 0, outputWidth, outputHeight)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('无法生成 PNG 图像'))
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function replaceForeignObjectLabels(svgDocument: Document) {
  const svgNamespace = 'http://www.w3.org/2000/svg'
  svgDocument.querySelectorAll('foreignObject').forEach((foreignObject) => {
    const width = Number.parseFloat(foreignObject.getAttribute('width') ?? '0')
    const height = Number.parseFloat(foreignObject.getAttribute('height') ?? '0')
    const x = Number.parseFloat(foreignObject.getAttribute('x') ?? '0')
    const y = Number.parseFloat(foreignObject.getAttribute('y') ?? '0')
    const paragraphs = Array.from(foreignObject.querySelectorAll('p'))
      .map((paragraph) => paragraph.textContent?.trim() ?? '')
      .filter(Boolean)
    const lines = paragraphs.length > 0
      ? paragraphs
      : [foreignObject.textContent?.trim() ?? ''].filter(Boolean)
    const text = svgDocument.createElementNS(svgNamespace, 'text')
    text.setAttribute('x', String(x + width / 2))
    text.setAttribute('y', String(y + height / 2))
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'middle')
    text.setAttribute('font-family', '"Microsoft YaHei", "Segoe UI", sans-serif')
    text.setAttribute('font-size', '16')
    lines.forEach((line, index) => {
      const tspan = svgDocument.createElementNS(svgNamespace, 'tspan')
      tspan.setAttribute('x', String(x + width / 2))
      tspan.setAttribute('dy', index === 0 ? `${-(lines.length - 1) * 0.6}em` : '1.2em')
      tspan.textContent = line
      text.appendChild(tspan)
    })
    foreignObject.replaceWith(text)
  })
}

function loadClipboardImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法加载流程图图像'))
    image.src = source
  })
}

function clampScale(value: number) {
  return Math.min(5, Math.max(0.5, value))
}

function readSvgAspectRatio(svg: string) {
  const { width, height } = readSvgDimensions(svg)
  return width / height
}

function fitSvgIntoViewport(aspectRatio: number, viewportWidth: number, viewportHeight: number) {
  const maxWidth = Math.max(240, viewportWidth - 84)
  const maxHeight = Math.max(180, viewportHeight - 170)
  let width = maxWidth
  let height = width / aspectRatio
  if (height > maxHeight) {
    height = maxHeight
    width = height * aspectRatio
  }
  return { width: Math.round(width), height: Math.round(height) }
}

function namespaceSvg(svg: string, prefix: string) {
  const ids = Array.from(svg.matchAll(/\bid="([^"]+)"/g), (match) => match[1])
  let namespaced = svg
  for (const id of ids.sort((left, right) => right.length - left.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    namespaced = namespaced.replace(new RegExp(`#${escaped}(?=[)"'\\s;,}])`, 'g'), `#${prefix}${id}`)
    namespaced = namespaced.replace(new RegExp(`id="${escaped}"`, 'g'), `id="${prefix}${id}"`)
  }
  return namespaced
}

function createMermaidConfig(themeMode: ThemeMode): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: themeMode === 'dark' ? 'dark' : 'neutral',
    flowchart: {
      htmlLabels: false,
      useMaxWidth: true,
    },
  }
}
