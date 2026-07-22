export type HeadingItem = { id: string; level: number; text: string }

export type ExternalResource = { tag: string; attr: string; url: string }

export type HtmlRenderInfo = {
  srcDoc: string
  headings: HeadingItem[]
  plainText: string
  externalResources: ExternalResource[]
}

export function rewriteRelativeResources(
  content: string,
  fileName: string,
  relativePath?: string,
  resources?: Record<string, string>,
) {
  if (!resources || Object.keys(resources).length === 0) return content
  const documentDir = dirname(relativePath ?? fileName)
  const resolve = (value: string) => {
    const cleanValue = value.trim().replace(/^['"]|['"]$/g, '')
    if (!cleanValue || isExternalUrl(cleanValue) || /^(data|blob|mailto|tel|javascript):/i.test(cleanValue) || cleanValue.startsWith('#')) return value
    return resources[normalizeResourcePath(documentDir, cleanValue)] ?? value
  }
  return content
    .replace(/(!\[[^\]]*]\()([^)\r\n]+)(\))/g, (match, prefix: string, url: string, suffix: string) => {
      const resolved = resolve(url)
      return resolved === url ? match : `${prefix}${resolved}${suffix}`
    })
    .replace(/\b(src|href)=("([^"]+)"|'([^']+)')/gi, (match, attr: string, quoted: string, doubleValue?: string, singleValue?: string) => {
      const value = doubleValue ?? singleValue ?? ''
      const resolved = resolve(value)
      if (resolved === value) return match
      const quote = quoted.startsWith("'") ? "'" : '"'
      return `${attr}=${quote}${resolved}${quote}`
    })
    .replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote: string, url: string) => {
      const resolved = resolve(url)
      return resolved === url ? match : `url(${quote}${resolved}${quote})`
    })
}

export function extractMarkdownHeadings(markdown: string): HeadingItem[] {
  const used = new Map<string, number>()
  const headings: HeadingItem[] = []
  let fence: { marker: '`' | '~'; length: number } | null = null

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (closingFence && closingFence[1][0] === fence.marker && closingFence[1].length >= fence.length) fence = null
      continue
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (openingFence) {
      fence = { marker: openingFence[1][0] as '`' | '~', length: openingFence[1].length }
      continue
    }

    // CommonMark only permits up to three leading spaces before an ATX heading.
    // Four-space indentation is a code block and must not appear in the TOC.
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*$/.exec(line)
    if (!match) continue

    const text = match[2].trim()
    const baseId = slugify(text)
    const count = used.get(baseId) ?? 0
    used.set(baseId, count + 1)
    headings.push({ id: count ? `${baseId}-${count}` : baseId, level: match[1].length, text })
  }

  return headings
}

export function buildSafeHtmlDocument(
  html: string,
  {
    allowExternalResources,
    allowScripts,
    allowForms,
    allowPopups = false,
  }: { allowExternalResources: boolean; allowScripts: boolean; allowForms: boolean; allowPopups?: boolean },
): HtmlRenderInfo {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const externalResources: ExternalResource[] = []
  const recordExternalResource = (element: Element, attr: string, url: string) => {
    if (isExternalUrl(url)) externalResources.push({ tag: element.tagName.toLowerCase(), attr, url })
  }

  parsed.querySelectorAll('script[src], iframe[src], object[data], embed[src]').forEach((element) => {
    for (const attr of ['src', 'data']) {
      const value = element.getAttribute(attr)
      if (value) recordExternalResource(element, attr, value)
    }
  })
  parsed.querySelectorAll('iframe,object,embed,meta[http-equiv]').forEach((node) => node.remove())
  if (!allowScripts) parsed.querySelectorAll('script').forEach((node) => node.remove())
  if (!allowForms) parsed.querySelectorAll('form').forEach((node) => node.remove())

  parsed.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value
      if (name === 'style') {
        collectExternalCssUrls(value).forEach((url) => recordExternalResource(element, 'style', url))
        if (!allowExternalResources) element.setAttribute(attribute.name, stripExternalCssUrls(value))
      }
      if (!allowScripts && name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        return
      }
      if (!allowScripts && (name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name)
        return
      }
      if (name === 'href' && element.tagName.toLowerCase() === 'a' && isExternalUrl(value)) {
        element.setAttribute('data-external-href', value)
        element.setAttribute('href', '#')
        return
      }
      if (name === 'action' && element.tagName.toLowerCase() === 'form' && isExternalUrl(value)) {
        element.removeAttribute(attribute.name)
        element.setAttribute('data-blocked-action', value)
        return
      }
      if ((name === 'href' || name === 'src') && isExternalUrl(value)) {
        recordExternalResource(element, name, value)
        if (!allowExternalResources) {
          element.removeAttribute(attribute.name)
          element.setAttribute(`data-blocked-${name}`, value)
          if (element.tagName.toLowerCase() === 'img') {
            const notice = parsed.createElement('span')
            notice.className = 'lp-missing-resource'
            notice.textContent = `外部图片已阻止：${value}`
            element.insertAdjacentElement('afterend', notice)
          }
        }
      }
    })
  })
  parsed.querySelectorAll('style').forEach((element) => {
    const css = element.textContent ?? ''
    collectExternalCssUrls(css).forEach((url) => recordExternalResource(element, 'style', url))
    if (!allowExternalResources) element.textContent = stripExternalCssUrls(css)
  })

  const headings = extractHtmlHeadings(parsed)
  const plainText = parsed.body.textContent?.replace(/\n{3,}/g, '\n\n').trim() ?? ''
  const bodyHtml = parsed.body.innerHTML
  const title = parsed.title || 'HTML 文档'
  parsed.head.querySelectorAll('base,title').forEach((node) => node.remove())
  const headHtml = parsed.head.innerHTML
  const externalLinkBridge = allowScripts
    ? `<script>(function(){var request=function(url){if(typeof url==='string'&&(url.toLowerCase().indexOf('http://')===0||url.toLowerCase().indexOf('https://')===0))parent.postMessage({type:'lightpage-external-link',url:url},'*');return null;};window.open=${allowPopups ? 'request' : 'function(){return null;}'};document.addEventListener('click',function(event){var link=event.target&&event.target.closest?event.target.closest('a[data-external-href]'):null;if(!link)return;event.preventDefault();request(link.getAttribute('data-external-href'));},true);})();</script>`
    : ''
  const formActionPolicy = allowForms ? "'self'" : "'none'"
  const contentSecurityPolicy = allowExternalResources
    ? `default-src 'self' data: blob: http: https:; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; connect-src http: https:; object-src 'none'; frame-src 'none'; form-action ${formActionPolicy}; navigate-to 'none'; base-uri 'none'`
    : `default-src 'none'; script-src 'unsafe-inline'; img-src data: blob: http://localhost/_capacitor_file_ capacitor://localhost; style-src 'unsafe-inline' http://localhost/_capacitor_file_ capacitor://localhost; font-src data: http://localhost/_capacitor_file_ capacitor://localhost; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action ${formActionPolicy}; navigate-to 'none'; base-uri 'none'`

  return {
    srcDoc: `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" /><base target="_self" /><style>html{-webkit-text-size-adjust:100%}body{overflow-wrap:anywhere}img,video,canvas,svg{max-width:100%;height:auto}.lp-missing-resource{display:block;margin:8px 0 14px;padding:9px 10px;border-radius:8px;color:#9a5b08;background:#fff1d8;font-size:.86em}mark.search-hit{padding:0 2px;border-radius:3px;color:#1f1600;background:#ffd86b}</style><title>${escapeHtml(title)}</title>${externalLinkBridge}${headHtml}</head><body>${bodyHtml}</body></html>`,
    headings,
    plainText,
    externalResources,
  }
}

function extractHtmlHeadings(root: Document): HeadingItem[] {
  const used = new Map<string, number>()
  return Array.from(root.body.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((element) => {
    const text = element.textContent?.trim() || '未命名标题'
    const baseId = slugify(text)
    const count = used.get(baseId) ?? 0
    used.set(baseId, count + 1)
    const id = count ? `${baseId}-${count}` : baseId
    element.id = element.id || id
    return { id: element.id, level: Number(element.tagName.slice(1)), text }
  })
}

function normalizeResourcePath(documentDir: string, resourcePath: string) {
  const [pathOnly] = resourcePath.split(/[?#]/, 1)
  let decoded = pathOnly
  try { decoded = decodeURIComponent(pathOnly) } catch { /* 保留原路径。 */ }
  const normalized: string[] = []
  for (const part of `${documentDir}/${decoded}`.replace(/\\/g, '/').split('/')) {
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

function isExternalUrl(value: string) {
  const normalized = value.trim()
  if (/^(?:https?|capacitor):\/\/localhost\/_capacitor_file_/i.test(normalized)) return false
  return /^(https?:)?\/\//i.test(normalized)
}

function collectExternalCssUrls(css: string) {
  return Array.from(css.matchAll(/(?:url\(\s*['"]?|@import\s+['"])((?:https?:)?\/\/[^'")\s;]+)/gi), (match) => match[1])
}

function stripExternalCssUrls(css: string) {
  return css.replace(/url\(\s*['"]?(?:https?:)?\/\/[^'")\s;]+['"]?\s*\)/gi, 'none')
    .replace(/@import\s+['"](?:https?:)?\/\/[^'"]+['"]\s*;?/gi, '')
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[`*_~()[\]{}:;'"，。！？、]/g, '').trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'heading'
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}
