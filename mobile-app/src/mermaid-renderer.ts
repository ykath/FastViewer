import type { LayoutLoaderDefinition, MermaidConfig } from 'mermaid'
import type { DiagramStyle, ThemeMode } from './reader-settings'

const refinedLayout = 'lightpage-flowchart'
const rectangleShapes = new Set(['rect', 'squareRect', 'proc', 'process', 'rectangle', 'rounded', 'roundedRect'])
const decisionShapes = new Set(['diamond', 'diam', 'decision', 'question'])
const fontFamily = 'system-ui, "Microsoft YaHei", sans-serif'
let registerLayouts: Promise<void> | undefined

type Mermaid = typeof import('mermaid').default

function loadLayouts(mermaid: Mermaid) {
  registerLayouts ??= import('@mermaid-js/layout-elk').then(({ default: layouts }) => {
    const elk = layouts.find((entry) => entry.name === 'elk')
    if (!elk) throw new Error('ELK layout is unavailable')
    const refined: LayoutLoaderDefinition = {
      name: refinedLayout,
      algorithm: elk.algorithm,
      async loader() {
        const engine = await elk.loader() as typeof import('@mermaid-js/layout-elk/dist/render.d.ts')
        const { createCommonLayoutRenderer, defaultMeasureLayout } = await import('mermaid')
        const render = createCommonLayoutRenderer({
          prepareLayout(data, context) {
            for (const node of data.nodes) {
              if (node.isGroup || !node.shape) continue
              const decision = decisionShapes.has(node.shape)
              if (!decision && !rectangleShapes.has(node.shape)) continue
              node.shape = 'rect'
              node.rx = node.ry = 16
              node.height = Math.max(node.height ?? 0, 60)
              node.labelPaddingX = 32
              node.padding = 14
              if (decision) node.cssClasses = (node.cssClasses ?? '') + ' lp-decision'
            }
            return engine.prepareLayoutForElk(data, context)
          },
          async measureLayout(data, context) {
            const measured = await defaultMeasureLayout(data, context)
            const edges = new Map(data.edges.map((edge) => [edge.id, edge]))
            measured.groups.edgeLabels.selectAll<SVGGElement, unknown>('g.label[data-id]').each(function () {
              const edge = edges.get(this.getAttribute('data-id') ?? '')
              const label = this.querySelector('text')
              const background = this.querySelector('rect.background')
              if (!edge?.label || !label || !background) return
              const bounds = label.getBBox()
              const width = bounds.width + 24
              const height = Math.max(26, bounds.height + 8)
              background.setAttribute('x', String(bounds.x - 12))
              background.setAttribute('y', String(bounds.y - (height - bounds.height) / 2))
              background.setAttribute('width', String(width))
              background.setAttribute('height', String(height))
              edge.width = width
              edge.height = height
            })
            return measured
          },
          runLayoutCore: engine.runElkLayoutCore,
          paintOptions: { skipIntersect: true },
        })
        return { render }
      },
    }
    mermaid.registerLayoutLoaders([...layouts, refined])
  }).catch((error: unknown) => {
    registerLayouts = undefined
    throw error
  })
  return registerLayouts
}

const palette = {
  light: { node: '#e3f1fc', border: '#cad9e7', text: '#07548f', decision: '#f1f8fe', line: '#737e89', edge: '#f3f8fd', cluster: '#f5f9fd' },
  dark: { node: '#20384e', border: '#486780', text: '#b8e0ff', decision: '#192e41', line: '#9aaebf', edge: '#233b51', cluster: '#182735' },
}

function refinedConfig(themeMode: ThemeMode): MermaidConfig {
  const colors = palette[themeMode]
  return {
    theme: 'base',
    darkMode: themeMode === 'dark',
    layout: refinedLayout,
    fontFamily,
    fontSize: 14,
    themeVariables: {
      fontFamily, fontSize: '14px', primaryColor: colors.node,
      primaryBorderColor: colors.border, primaryTextColor: colors.text,
      lineColor: colors.line, edgeLabelBackground: colors.edge,
      clusterBkg: colors.cluster, clusterBorder: colors.border, titleColor: colors.text,
    },
    themeCSS: [
      '.node text, .edgeLabel text { font-weight: 600; }',
      '.node text { font-size: 14px; }',
      '.node tspan[font-weight="normal"], .edgeLabel tspan[font-weight="normal"] { font-weight: 600; }',
      '.node rect.label-container { rx: 16px; ry: 16px; }',
      '.edgeLabel text { font-size: 13px; }',
      '.edgeLabel rect.background { opacity: 1; rx: 12px; ry: 12px; fill: ' + colors.edge + '; stroke: ' + colors.border + ' !important; stroke-width: 1px; }',
      '.lp-decision .label-container { fill: ' + colors.decision + '; stroke-dasharray: 2 2; }',
      '.edgeLabel text { fill: ' + colors.text + '; }',
      '.edgePaths .flowchart-link { stroke-width: 1px; stroke-linejoin: round; stroke-linecap: round; }',
    ].join('\n'),
    flowchart: { useMaxWidth: false, nodeSpacing: 40, rankSpacing: 40, diagramPadding: 8, curve: 'rounded' },
  }
}

const secureKeys = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels']

function sourceOptions(source: string) {
  const frontmatter = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  const body = source.slice(frontmatter?.[0].length ?? 0)
  const header = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('%%'))
  const flowchart = /^(?:flowchart|graph)\b/i.test(header ?? '')
  const hasConfig = /(?:^|\n)\s*config\s*:/i.test(frontmatter?.[1] ?? '') || /%%\{\s*(?:init|initialize)\s*:/i.test(body)
  // Recognize author directives, leaving the parsing and shape handling to Mermaid.
  const hasStyles = /(?:^|[;\n])\s*(?:classDef|class|style|linkStyle)\s+/i.test(body) || /:::[\w-]+/.test(body)
  const explicitElk = /(?:^|[{\s,])["']?layout["']?\s*:\s*["']?elk(?:[.\w-]*)\b/i.test(source)
    || /(?:^|[{\s,])["']?defaultRenderer["']?\s*:\s*["']?elk\b/i.test(source)
  return { flowchart, hasConfig, hasStyles, explicitElk }
}

export async function renderMermaidSvg(
  source: string, themeMode: ThemeMode, diagramStyle: DiagramStyle, id: string, host: HTMLElement,
) {
  const { default: mermaid } = await import('mermaid')
  const { flowchart, hasConfig, hasStyles, explicitElk } = sourceOptions(source)
  const useRefined = diagramStyle === 'refined' && flowchart && !hasConfig && !hasStyles
  const render = async (refined: boolean) => {
    const appearance: MermaidConfig = refined
      ? refinedConfig(themeMode)
      : { theme: themeMode === 'dark' ? 'dark' : 'neutral', flowchart: { useMaxWidth: false } }
    mermaid.initialize({
      ...appearance,
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      secure: secureKeys,
    })
    const { svg } = await mermaid.render(id, source, host)
    return svg
  }

  await document.fonts?.ready
  if (useRefined) {
    try {
      await loadLayouts(mermaid)
      return { svg: await render(true), appearance: 'refined' as const }
    } catch {
      host.replaceChildren()
      return { svg: await render(false), appearance: 'fallback' as const }
    }
  }
  if (explicitElk) await loadLayouts(mermaid).catch(() => undefined)
  return { svg: await render(false), appearance: 'original' as const }
}
