export type RichTextPayload = {
  html: string
  text: string
}

type RichTextBuildOptions = {
  renderMermaid?: (svg: SVGSVGElement) => Promise<string>
}

type ClipboardItemConstructor = new (
  items: Record<string, Blob>,
  options?: ClipboardItemOptions,
) => ClipboardItem

type ClipboardWriteDependencies = {
  clipboard?: Pick<Clipboard, 'write'>
  ClipboardItemClass?: ClipboardItemConstructor
  document?: Document
}

const BLOCK_ELEMENTS = [
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]

const PORTABLE_STYLES: Record<string, string> = {
  article: 'font-family:Arial,"Microsoft YaHei",sans-serif;font-size:16px;line-height:1.65;color:#202124;background:#ffffff;',
  h1: 'font-size:28px;line-height:1.25;font-weight:700;color:#202124;margin:24px 0 14px;',
  h2: 'font-size:23px;line-height:1.3;font-weight:700;color:#202124;margin:22px 0 12px;',
  h3: 'font-size:19px;line-height:1.35;font-weight:700;color:#202124;margin:20px 0 10px;',
  h4: 'font-size:17px;line-height:1.4;font-weight:700;color:#202124;margin:18px 0 8px;',
  h5: 'font-size:16px;line-height:1.4;font-weight:700;color:#202124;margin:16px 0 8px;',
  h6: 'font-size:15px;line-height:1.4;font-weight:700;color:#5f6368;margin:16px 0 8px;',
  p: 'margin:0 0 14px;',
  ul: 'margin:0 0 14px;padding-left:26px;',
  ol: 'margin:0 0 14px;padding-left:26px;',
  li: 'margin:0 0 4px;',
  blockquote: 'margin:16px 0;padding:10px 14px;border-left:4px solid #188038;background:#f1f8f4;color:#3c4043;',
  pre: 'margin:16px 0;padding:12px 14px;border:1px solid #dadce0;background:#f8f9fa;color:#202124;font-family:Consolas,"Courier New",monospace;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;',
  code: 'font-family:Consolas,"Courier New",monospace;font-size:0.92em;background:#f1f3f4;color:#174ea6;padding:1px 4px;border-radius:3px;',
  table: 'width:100%;margin:16px 0;border-collapse:collapse;border:1px solid #dadce0;font-size:14px;',
  th: 'padding:8px 10px;border:1px solid #dadce0;background:#f1f3f4;color:#202124;font-weight:700;text-align:left;',
  td: 'padding:8px 10px;border:1px solid #dadce0;color:#202124;text-align:left;vertical-align:top;',
  a: 'color:#1155cc;text-decoration:underline;',
  img: 'display:block;max-width:100%;height:auto;margin:12px 0;',
  hr: 'margin:22px 0;border:0;border-top:1px solid #dadce0;',
  strong: 'font-weight:700;',
  b: 'font-weight:700;',
  em: 'font-style:italic;',
  i: 'font-style:italic;',
  del: 'text-decoration:line-through;color:#5f6368;',
  s: 'text-decoration:line-through;color:#5f6368;',
}

export async function buildRichTextPayload(
  root: HTMLElement,
  title: string,
  options: RichTextBuildOptions = {},
): Promise<RichTextPayload> {
  const clone = root.cloneNode(true) as HTMLElement
  await replaceMermaidDiagrams(root, clone, options.renderMermaid ?? renderSvgAsPngDataUrl)
  replaceKatex(clone)
  replaceTaskCheckboxes(clone)
  replaceImageFallbacks(clone)
  replaceVideoPlayers(clone)
  unwrapMatches(clone, 'mark.search-hit, mark.annotation-highlight')
  unwrapMatches(clone, '.markdown-table-wrap, .render-block')
  clone.querySelectorAll('style, script, button, .mermaid-render-host, .mermaid-status, .mermaid-zoom-overlay').forEach((element) => element.remove())
  clone.querySelectorAll('svg').forEach((element) => element.remove())
  applyPortableStyles(clone)
  cleanInternalAttributes(clone)

  const text = extractPortableText(clone)
  const escapedTitle = escapeHtml(title)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapedTitle}</title></head><body style="margin:0;padding:0;background:#ffffff;">${clone.outerHTML}</body></html>`
  return { html, text }
}

export async function writeRichTextToClipboard(
  payload: RichTextPayload,
  dependencies: ClipboardWriteDependencies = {},
): Promise<void> {
  const clipboard = dependencies.clipboard ?? navigator.clipboard
  const ClipboardItemClass = dependencies.ClipboardItemClass ?? globalThis.ClipboardItem
  if (clipboard?.write && ClipboardItemClass) {
    try {
      await clipboard.write([new ClipboardItemClass({
        'text/html': new Blob([payload.html], { type: 'text/html;charset=utf-8' }),
        'text/plain': new Blob([payload.text], { type: 'text/plain;charset=utf-8' }),
      }, { presentationStyle: 'inline' })])
      return
    } catch {
      // WebView may expose ClipboardItem but reject HTML; use the copy-event path below.
    }
  }

  const targetDocument = dependencies.document ?? document
  if (!copyWithClipboardEvent(targetDocument, payload)) {
    throw new Error('系统剪贴板不支持富文本写入')
  }
}

export async function writePlainTextToClipboard(text: string, targetDocument: Document = document): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = targetDocument.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;'
    targetDocument.body.appendChild(textarea)
    textarea.select()
    try {
      return targetDocument.execCommand('copy')
    } catch {
      return false
    } finally {
      textarea.remove()
    }
  }
}

export async function waitForRichTextRender(
  getRoot: () => HTMLElement | null,
  timeoutMs = 15_000,
): Promise<HTMLElement> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const root = getRoot()
    if (root) {
      const planReady = !root.classList.contains('progressive-markdown') || root.dataset.renderComplete === 'true'
      const blocksReady = Array.from(root.querySelectorAll<HTMLElement>('[data-render-block]'))
        .every((block) => block.dataset.richCopyReady === 'true')
      const diagramsReady = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-diagram'))
        .every((diagram) => diagram.dataset.renderStatus === 'ready' || diagram.dataset.renderStatus === 'error')
      if (planReady && blocksReady && diagramsReady) return root
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
  throw new Error('完整 Markdown 渲染超时')
}

function copyWithClipboardEvent(targetDocument: Document, payload: RichTextPayload) {
  const selection = targetDocument.getSelection()
  const savedRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const holder = targetDocument.createElement('div')
  holder.contentEditable = 'true'
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;'
  holder.innerHTML = payload.html
  targetDocument.body.appendChild(holder)

  const range = targetDocument.createRange()
  range.selectNodeContents(holder)
  selection?.removeAllRanges()
  selection?.addRange(range)
  const handleCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/html', payload.html)
    event.clipboardData.setData('text/plain', payload.text)
    event.preventDefault()
  }
  targetDocument.addEventListener('copy', handleCopy, { once: true })
  try {
    return targetDocument.execCommand('copy')
  } catch {
    return false
  } finally {
    targetDocument.removeEventListener('copy', handleCopy)
    holder.remove()
    selection?.removeAllRanges()
    savedRanges.forEach((savedRange) => selection?.addRange(savedRange))
  }
}

async function replaceMermaidDiagrams(
  original: HTMLElement,
  clone: HTMLElement,
  renderMermaid: (svg: SVGSVGElement) => Promise<string>,
) {
  const originals = Array.from(original.querySelectorAll<HTMLElement>('.mermaid-diagram'))
  const clones = Array.from(clone.querySelectorAll<HTMLElement>('.mermaid-diagram'))
  await Promise.all(clones.map(async (figure, index) => {
    const sourceFigure = originals[index]
    const source = sourceFigure?.dataset.mermaidSource ?? figure.dataset.mermaidSource ?? ''
    const svg = sourceFigure?.querySelector<SVGSVGElement>('.mermaid-svg svg')
    if (svg) {
      try {
        const image = clone.ownerDocument.createElement('img')
        image.src = await renderMermaid(svg)
        image.alt = 'Mermaid 流程图'
        figure.replaceWith(image)
        return
      } catch {
        // Keep a readable source fallback when the canvas cannot encode this diagram.
      }
    }
    const pre = clone.ownerDocument.createElement('pre')
    const code = clone.ownerDocument.createElement('code')
    code.textContent = source || sourceFigure?.textContent?.trim() || 'Mermaid 流程图'
    pre.appendChild(code)
    figure.replaceWith(pre)
  }))
}

function replaceKatex(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.katex').forEach((element) => {
    if (element.closest('.katex') !== element) return
    const source = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
    if (!source) return
    const display = Boolean(element.closest('.katex-display'))
    const replacement = root.ownerDocument.createElement(display ? 'div' : 'code')
    replacement.textContent = display ? source : `$${source}$`
    if (display) replacement.style.cssText = 'margin:16px 0;text-align:center;font-family:Cambria Math,serif;'
    element.replaceWith(replacement)
  })
}

function replaceTaskCheckboxes(root: HTMLElement) {
  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    const marker = root.ownerDocument.createElement('span')
    marker.textContent = checkbox.checked ? '☑ ' : '☐ '
    checkbox.replaceWith(marker)
  })
}

function replaceImageFallbacks(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.img-fallback').forEach((fallback) => {
    const text = fallback.textContent?.trim() || '图片加载失败'
    const replacement = root.ownerDocument.createElement('span')
    replacement.textContent = `[图片：${text}]`
    fallback.replaceWith(replacement)
  })
}

function replaceVideoPlayers(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.markdown-video, .markdown-video-fallback').forEach((element) => {
    const title = element.getAttribute('title')
      || element.querySelector('source')?.getAttribute('src')?.split(/[\\/]/).pop()
      || element.textContent?.trim()
      || '视频'
    const replacement = root.ownerDocument.createElement('span')
    replacement.textContent = title === '视频' ? '[视频]' : `[视频：${title}]`
    element.replaceWith(replacement)
  })
}

function unwrapMatches(root: HTMLElement, selector: string) {
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => element.replaceWith(...Array.from(element.childNodes)))
}

function applyPortableStyles(root: HTMLElement) {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
  elements.forEach((element) => {
    const tag = element.tagName.toLowerCase()
    const taskItem = element.classList.contains('task-list-item')
    if (PORTABLE_STYLES[tag]) element.setAttribute('style', PORTABLE_STYLES[tag])
    if (tag === 'code' && element.parentElement?.tagName.toLowerCase() === 'pre') {
      element.setAttribute('style', 'font-family:Consolas,"Courier New",monospace;font-size:inherit;background:transparent;color:inherit;padding:0;white-space:pre-wrap;')
    }
    if (taskItem) element.setAttribute('style', `${PORTABLE_STYLES.li}list-style:none;margin-left:-20px;`)
  })
}

function cleanInternalAttributes(root: HTMLElement) {
  const allowed = new Set(['style', 'href', 'src', 'alt', 'colspan', 'rowspan', 'start', 'reversed'])
  ;[root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      if (!allowed.has(name)) element.removeAttribute(attribute.name)
    })
  })
}

function extractPortableText(root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('br').forEach((element) => element.replaceWith('\n'))
  clone.querySelectorAll<HTMLImageElement>('img').forEach((image) => image.replaceWith(image.alt ? `[图片：${image.alt}]` : '[图片]'))
  clone.querySelectorAll('th, td').forEach((element) => element.append('\t'))
  clone.querySelectorAll(BLOCK_ELEMENTS.join(',')).forEach((element) => element.append('\n'))
  return (clone.textContent ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function renderSvgAsPngDataUrl(svg: SVGSVGElement) {
  const serialized = new XMLSerializer().serializeToString(svg)
  const dimensions = readSvgDimensions(svg)
  const maxDimensionScale = 4096 / Math.max(dimensions.width, dimensions.height)
  const maxPixelScale = Math.sqrt(12_000_000 / (dimensions.width * dimensions.height))
  const scale = Math.max(0.1, Math.min(2, maxDimensionScale, maxPixelScale))
  const width = Math.max(1, Math.round(dimensions.width * scale))
  const height = Math.max(1, Math.round(dimensions.height * scale))
  const source = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await loadImage(source)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建流程图画布')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(source)
  }
}

function readSvgDimensions(svg: SVGSVGElement) {
  const viewBox = svg.viewBox?.baseVal
  const width = viewBox?.width || Number.parseFloat(svg.getAttribute('width') ?? '') || svg.getBoundingClientRect().width || 1200
  const height = viewBox?.height || Number.parseFloat(svg.getAttribute('height') ?? '') || svg.getBoundingClientRect().height || 800
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法加载流程图图像'))
    image.src = source
  })
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}
