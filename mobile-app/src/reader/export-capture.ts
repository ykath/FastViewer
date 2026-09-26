import type { DocumentType } from '../document-types'
import type { HeadingItem } from '../html-processing'
import type { ThemeMode } from '../reader-settings'

export function findActiveHeading(
  fileType: DocumentType,
  headings: HeadingItem[],
  iframe: HTMLIFrameElement | null,
) {
  let active = ''
  const frameTop = fileType === 'html' ? iframe?.getBoundingClientRect().top ?? 0 : 0
  for (const heading of headings) {
    let element: HTMLElement | null | undefined
    try {
      element = fileType === 'html'
        ? iframe?.contentDocument?.getElementById(heading.id)
        : window.document.getElementById(heading.id)
    } catch {
      return active
    }
    if (!element) continue
    const top = element.getBoundingClientRect().top + frameTop
    if (top <= 132) active = heading.id
    else if (!active) return heading.id
    else break
  }
  return active
}

export const MAX_EXPORT_CANVAS_EDGE = 32767
export const MAX_EXPORT_CANVAS_PIXELS = 12_000_000
export const EXPORT_RESOURCE_WAIT_TIMEOUT_MS = 3000

export function calculateExportScale(width: number, height: number) {
  const edgeScale = MAX_EXPORT_CANVAS_EDGE / Math.max(1, width, height)
  const pixelScale = Math.sqrt(MAX_EXPORT_CANVAS_PIXELS / Math.max(1, width * height))
  return Math.max(0.01, Math.min(2, edgeScale, pixelScale))
}

export function canvasToPngBytes(canvas: HTMLCanvasElement) {
  return new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法生成 PNG 图片'))
        return
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
}

export function cropCanvas(source: HTMLCanvasElement, top: number, height: number) {
  const output = document.createElement('canvas')
  output.width = source.width
  output.height = Math.max(1, Math.min(height, source.height - top))
  output.getContext('2d')?.drawImage(
    source,
    0,
    top,
    source.width,
    output.height,
    0,
    0,
    output.width,
    output.height,
  )
  return output
}

export function paginateCanvas(source: HTMLCanvasElement) {
  const pageHeight = Math.max(1, Math.round(source.width * 1.414))
  const pages: HTMLCanvasElement[] = []
  for (let top = 0; top < source.height; top += pageHeight) {
    pages.push(cropCanvas(source, top, Math.min(pageHeight, source.height - top)))
  }
  return pages
}

export async function captureHtmlFrameAsCanvas(iframe: HTMLIFrameElement | null, themeMode: ThemeMode) {
  const frameDocument = iframe?.contentDocument
  const frameWindow = iframe?.contentWindow
  const targetElement = frameDocument?.body
  if (!iframe || !frameDocument || !frameWindow || !targetElement) {
    throw new Error('无法获取 HTML 绘制区域')
  }

  await waitForFrameResources(frameDocument)

  const originalHeight = iframe.style.height
  const originalOverflow = iframe.style.overflow

  try {
    let { width, height } = measureFrameDocument(frameDocument, iframe)
    iframe.style.height = `${height}px`
    iframe.style.overflow = 'hidden'

    await nextAnimationFrame(frameWindow)
    await nextAnimationFrame(frameWindow)

    ;({ width, height } = measureFrameDocument(frameDocument, iframe))
    const backgroundColor = resolveFrameBackground(frameDocument, themeMode)
    const scale = calculateExportScale(width, height)

    const { default: html2canvas } = await import('html2canvas-pro')
    return html2canvas(targetElement, {
      useCORS: true,
      scale,
      backgroundColor,
      windowWidth: width,
      windowHeight: height,
      width,
      height,
      scrollX: 0,
      scrollY: 0,
    })
  } finally {
    iframe.style.height = originalHeight
    iframe.style.overflow = originalOverflow
  }
}

export async function captureHtmlSourceAsCanvas(srcDoc: string, themeMode: ThemeMode) {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;'
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.srcdoc = srcDoc
  document.body.appendChild(iframe)
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('HTML 导出准备超时')), 5000)
      iframe.addEventListener('load', () => {
        window.clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
    return await captureHtmlFrameAsCanvas(iframe, themeMode)
  } finally {
    iframe.remove()
  }
}

export async function waitForFrameResources(frameDocument: Document) {
  await frameDocument.fonts?.ready.catch(() => undefined)

  const images = Array.from(frameDocument.images).filter((image) => !image.complete)
  await Promise.race([
    Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true })
            image.addEventListener('error', () => resolve(), { once: true })
          }),
      ),
    ),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, EXPORT_RESOURCE_WAIT_TIMEOUT_MS)
    }),
  ])
}

export function measureFrameDocument(frameDocument: Document, iframe: HTMLIFrameElement) {
  const body = frameDocument.body
  const root = frameDocument.documentElement
  const width = Math.ceil(Math.max(
    iframe.clientWidth,
    root.clientWidth,
    root.scrollWidth,
    body.clientWidth,
    body.scrollWidth,
    body.offsetWidth,
  ))
  const height = Math.ceil(Math.max(
    iframe.clientHeight,
    root.clientHeight,
    root.scrollHeight,
    body.clientHeight,
    body.scrollHeight,
    body.offsetHeight,
  ))

  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  }
}

export function resolveFrameBackground(frameDocument: Document, themeMode: ThemeMode) {
  const fallback = themeMode === 'dark' ? '#171e1a' : '#fffdf8'
  const frameWindow = frameDocument.defaultView
  if (!frameWindow) return fallback

  const bodyColor = frameWindow.getComputedStyle(frameDocument.body).backgroundColor
  if (bodyColor && bodyColor !== 'rgba(0, 0, 0, 0)' && bodyColor !== 'transparent') return bodyColor

  const rootColor = frameWindow.getComputedStyle(frameDocument.documentElement).backgroundColor
  if (rootColor && rootColor !== 'rgba(0, 0, 0, 0)' && rootColor !== 'transparent') return rootColor

  return fallback
}

export function nextAnimationFrame(frameWindow: Window) {
  return new Promise<void>((resolve) => {
    frameWindow.requestAnimationFrame(() => resolve())
  })
}

export const PRINT_CSS = `<style>@media print{body{margin:0;padding:12mm}table{page-break-inside:avoid}pre{white-space:pre-wrap;word-break:break-all}img{max-width:100%;page-break-inside:avoid}h1,h2,h3,h4,h5,h6{page-break-after:avoid}.reader-header,.reader-toolbar,.search-panel,.reader-status,.sheet-backdrop{display:none!important}}</style>`

export function buildPrintDocument(title: string, bodyHtml: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color: #33413a; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.72; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px 20px 40px; }
    h1,h2,h3,h4,h5,h6 { color: #111a16; line-height: 1.28; margin: 1.4em 0 .65em; }
    h1 { font-size: 1.7em; margin-top: 0; }
    h2 { font-size: 1.42em; }
    h3 { font-size: 1.16em; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 16px; }
    img, video { max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #dde5dd; }
    th, td { padding: 8px 10px; border: 1px solid #dde5dd; }
    th { background: #f3f6f2; color: #111a16; }
    pre { padding: 13px; border-radius: 4px; overflow-x: auto; background: #f5f5f5; color: #333; }
    code { font-family: SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
    a { color: #138263; text-decoration: none; }
    blockquote { padding: 10px 12px; border-left: 3px solid #138263; background: #e3f3ed; margin-left: 0; }
    mark.search-hit { background: transparent; color: inherit; }
  </style>
  ${PRINT_CSS}
</head>
<body>${bodyHtml}</body>
</html>`
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function highlightMatches(container: HTMLElement, query: string) {
  clearHighlights(container)
  const needle = query.trim()
  if (!needle) return []

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      return parent?.closest('style, script, [data-search-exclude="true"], .katex')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node instanceof Text && node.nodeValue?.toLowerCase().includes(needle.toLowerCase())) {
      textNodes.push(node)
    }
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? ''
    const lowerText = text.toLowerCase()
    const lowerNeedle = needle.toLowerCase()
    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let index = lowerText.indexOf(lowerNeedle)

    while (index >= 0) {
      fragment.append(document.createTextNode(text.slice(lastIndex, index)))
      const mark = document.createElement('mark')
      mark.className = 'search-hit'
      mark.textContent = text.slice(index, index + needle.length)
      fragment.append(mark)
      lastIndex = index + needle.length
      index = lowerText.indexOf(lowerNeedle, lastIndex)
    }

    fragment.append(document.createTextNode(text.slice(lastIndex)))
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return Array.from(container.querySelectorAll<HTMLElement>('mark.search-hit'))
}

export function clearHighlights(container: HTMLElement) {
  container.querySelectorAll('mark.search-hit').forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''))
  })
  container.normalize()
}
