export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'])

export type MarkdownVideoSource = {
  src: string
  type?: string
}

export function parseMarkdownVideoPayload(raw: unknown): MarkdownVideoPayload | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw) as MarkdownVideoPayload
    if (!parsed || (parsed.variant !== 'file' && parsed.variant !== 'youtube' && parsed.variant !== 'bilibili')) return null
    if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

export type MarkdownVideoPayload = {
  variant: 'file' | 'youtube' | 'bilibili'
  sources: MarkdownVideoSource[]
  poster?: string
  width?: string
  height?: string
  controls: boolean
  loop?: boolean
  muted?: boolean
  preload?: string
  label?: string
}

export function isVideoPath(pathOrUrl: string) {
  const pathOnly = pathOrUrl.split(/[?#]/, 1)[0]
  const extension = pathOnly.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.has(extension)
}

export function isRemoteVideoUrl(url: string) {
  return /^https?:\/\//i.test(url) && isVideoPath(url)
}

export function decodeLocalResourcePath(source: string) {
  const pathOnly = source.split(/[?#]/, 1)[0]
  if (!pathOnly || /^(?:[a-z][a-z\d+.-]*:|\/\/|[\\/])/i.test(pathOnly)) return ''
  try {
    return decodeURIComponent(pathOnly)
  } catch {
    return pathOnly
  }
}

export function normalizeArchiveResourcePath(documentDir: string, resourcePath: string) {
  const [pathOnly] = resourcePath.split(/[?#]/, 1)
  let decoded = pathOnly
  try { decoded = decodeURIComponent(pathOnly) } catch { /* keep */ }
  const parts = `${documentDir}/${decoded}`.replace(/\\/g, '/').split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return normalized.join('/').toLowerCase()
}

export function normalizeResourceKey(source: string) {
  const normalized: string[] = []
  for (const part of source.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return normalized.join('/').toLowerCase()
}

export function extractYouTubeId(input: string) {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || ''
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'm.youtube.com') {
      if (url.pathname.startsWith('/embed/')) return url.pathname.split('/')[2] ?? ''
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] ?? ''
      return url.searchParams.get('v') ?? ''
    }
  } catch {
    return ''
  }
  return ''
}

export function extractBilibiliId(input: string) {
  const trimmed = input.trim()
  const bv = trimmed.match(/(BV[\w]+)/i)?.[1]
  if (bv) return bv
  try {
    const url = new URL(trimmed)
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'bilibili.com' || host === 'player.bilibili.com') {
      const match = url.pathname.match(/\/video\/(BV[\w]+)/i)
      return match?.[1] ?? ''
    }
  } catch {
    return ''
  }
  return ''
}

export function buildYouTubeEmbedUrl(videoId: string) {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`
}

export function buildBilibiliEmbedUrl(bvid: string) {
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&autoplay=0`
}

export function normalizeMarkdownVideoHtml(content: string) {
  return content.replace(/<video\b[\s\S]*?<\/video>/gi, (block) => block.replace(/\s*\r?\n\s*/g, ' '))
}

export function parseVideoHtmlBlock(html: string): MarkdownVideoPayload | null {
  const match = /<video\b([^>]*)>([\s\S]*?)<\/video>/i.exec(html.trim())
  if (!match) {
    const selfClosing = /<video\b([^>]*)\/>/i.exec(html.trim())
    if (!selfClosing) return null
    return payloadFromVideoTag(selfClosing[1], '')
  }
  return payloadFromVideoTag(match[1], match[2])
}

function payloadFromVideoTag(attributeSource: string, innerHtml: string): MarkdownVideoPayload | null {
  const attributes = parseHtmlAttributes(attributeSource)
  const sources: MarkdownVideoSource[] = []
  for (const sourceMatch of innerHtml.matchAll(/<source\b([^>]*)\/?>/gi)) {
    const sourceAttrs = parseHtmlAttributes(sourceMatch[1])
    if (sourceAttrs.src) sources.push({ src: sourceAttrs.src, type: sourceAttrs.type })
  }
  if (attributes.src) sources.unshift({ src: attributes.src, type: attributes.type })
  if (sources.length === 0) return null
  return {
    variant: 'file',
    sources,
    poster: attributes.poster,
    width: attributes.width,
    height: attributes.height,
    controls: attributes.controls !== undefined,
    loop: attributes.loop !== undefined,
    muted: attributes.muted !== undefined,
    preload: attributes.preload,
  }
}

function parseHtmlAttributes(source: string) {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g)) {
    const key = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (key === 'controls' || key === 'loop' || key === 'muted' || key === 'autoplay') {
      attributes[key] = value || key
    } else {
      attributes[key] = value
    }
  }
  return attributes
}

export function extractLocalMarkdownMediaSources(content: string) {
  const sources: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const localPath = decodeLocalResourcePath(raw)
    if (!localPath || !isVideoPath(localPath) || seen.has(localPath)) return
    seen.add(localPath)
    sources.push(localPath)
  }

  const imagePattern = /!\[[^\]]*]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+["'][^"'\r\n]*["'])?\s*\)/g
  for (const match of content.matchAll(imagePattern)) {
    add((match[1] ?? match[2] ?? '').trim())
  }

  const linkPattern = /(?<!!)\[[^\]]*]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))/g
  for (const match of content.matchAll(linkPattern)) {
    add((match[1] ?? match[2] ?? '').trim())
  }

  for (const match of content.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?]]/g)) {
    const source = match[1].trim()
    if (isVideoPath(source)) add(source)
  }

  for (const match of content.matchAll(/@\[(?:video|youtube|bilibili)]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))/gi)) {
    add((match[1] ?? match[2] ?? '').trim())
  }

  for (const match of content.matchAll(/<video\b[^>]*>/gi)) {
    const tag = match[0]
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/i.exec(tag)
    if (srcMatch) add((srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim())
  }
  for (const match of content.matchAll(/<source\b[^>]*>/gi)) {
    const tag = match[0]
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/i.exec(tag)
    if (srcMatch) add((srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim())
  }

  return sources
}

export function extractLocalMarkdownImageSources(content: string) {
  const sources: string[] = []
  const seen = new Set<string>()
  const imagePattern = /!\[[^\]]*]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+["'][^"'\r\n]*["'])?\s*\)/g
  for (const match of content.matchAll(imagePattern)) {
    const source = (match[1] ?? match[2] ?? '').trim()
    if (isVideoPath(source)) continue
    const localPath = decodeLocalResourcePath(source)
    if (!localPath || seen.has(localPath)) continue
    seen.add(localPath)
    sources.push(localPath)
  }
  return sources
}
