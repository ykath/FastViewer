import { useEffect, useId, useRef, useState } from 'react'
import type { MermaidConfig, RenderResult } from 'mermaid'
import type { ThemeMode } from './reader-settings'

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

  return (
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
  )
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
