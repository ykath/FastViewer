import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type AdapterName = 'generic' | 'x' | 'youtube' | 'hn'

export type QualityResult = {
  acceptable: boolean
  reason?: string
}

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const FAILURE_MARKERS = [
  /application error/i,
  /this page could not be found/i,
  /just a moment/i,
  /checking your browser/i,
  /verify you are human/i,
  /captcha/i,
  /登录后继续|请先登录|sign in to continue/i,
]

export function normalizeImportUrl(input: string): URL {
  const value = input.trim()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('请输入有效的网页 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// URL')
  }
  parsed.hash = ''
  return parsed
}

export function adapterForUrl(url: URL): AdapterName {
  const host = url.hostname.toLowerCase()
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x'
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube'
  if (host === 'news.ycombinator.com') return 'hn'
  return 'generic'
}

export function safeWindowsSlug(input: string, fallback = 'article'): string {
  const collapsed = input
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80)
    .replace(/[.\s]+$/g, '')
  const candidate = collapsed || fallback
  return WINDOWS_RESERVED_NAMES.test(candidate) ? `_${candidate}` : candidate
}

export function articleOutputPath(root: string, url: URL, title: string, now = new Date()): { directory: string; markdownPath: string; slug: string } {
  const domain = safeWindowsSlug(url.hostname.toLowerCase(), 'website')
  const baseSlug = safeWindowsSlug(title || url.pathname.split('/').filter(Boolean).pop() || 'article')
  let slug = baseSlug
  let directory = join(root, domain, slug)
  if (existsSync(directory)) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    slug = `${baseSlug}-${stamp}`
    directory = join(root, domain, slug)
    let sequence = 2
    while (existsSync(directory)) {
      slug = `${baseSlug}-${stamp}-${sequence}`
      directory = join(root, domain, slug)
      sequence += 1
    }
  }
  return { directory, markdownPath: join(directory, `${slug}.md`), slug }
}

export function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r\n/g, '\n'))
}

export function renderMarkdownDocument(input: {
  title: string
  requestedUrl: string
  canonicalUrl?: string
  author?: string
  siteName?: string
  publishedAt?: string
  adapter: AdapterName
  markdown: string
}): string {
  const fields = [
    `title: ${yamlString(input.title)}`,
    `url: ${yamlString(input.canonicalUrl || input.requestedUrl)}`,
    `requestedUrl: ${yamlString(input.requestedUrl)}`,
    input.author ? `author: ${yamlString(input.author)}` : '',
    input.siteName ? `siteName: ${yamlString(input.siteName)}` : '',
    input.publishedAt ? `publishedAt: ${yamlString(input.publishedAt)}` : '',
    `adapter: ${yamlString(input.adapter)}`,
    `capturedAt: ${yamlString(new Date().toISOString())}`,
  ].filter(Boolean)
  const body = input.markdown.trim()
  const normalizedTitle = input.title.trim().toLocaleLowerCase()
  const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim().toLocaleLowerCase()
  const titleHeading = firstHeading === normalizedTitle ? '' : `# ${input.title}\n\n`
  return `---\n${fields.join('\n')}\n---\n\n${titleHeading}${body}\n`
}

export function assessQuality(markdown: string, title: string, adapter: AdapterName): QualityResult {
  const body = markdown.replace(/^---[\s\S]*?---\s*/, '').trim()
  for (const marker of FAILURE_MARKERS) {
    if (marker.test(`${title}\n${body}`)) return { acceptable: false, reason: '页面显示登录、验证或错误内容' }
  }
  if (!title.trim()) return { acceptable: false, reason: '未识别到页面标题' }
  if (!body) return { acceptable: false, reason: '未提取到正文' }
  const minimum = adapter === 'generic' ? 120 : adapter === 'hn' ? 10 : 1
  if (body.length < minimum) return { acceptable: false, reason: '提取到的正文过短，可能只是页面外壳' }
  if (adapter === 'generic') {
    const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
    const normalizeTitle = (value: string) => value.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
    const expected = normalizeTitle(title)
    const actual = normalizeTitle(firstHeading || '')
    if (actual.length >= 4 && expected.length >= 4 && !actual.includes(expected) && !expected.includes(actual)) {
      return { acceptable: false, reason: '正文标题与页面标题关联度不足' }
    }
    const links = Array.from(body.matchAll(/\[([^\]]+)]\([^\s)]+\)/g))
    const linkCharacters = links.reduce((total, match) => total + match[1].length, 0)
    const visibleCharacters = body.replace(/!\[[^\]]*]\([^)]*\)/g, '').replace(/\[([^\]]+)]\([^)]*\)/g, '$1').replace(/\s/g, '').length
    if (links.length >= 8 && visibleCharacters > 0 && linkCharacters / visibleCharacters > 0.65) {
      return { acceptable: false, reason: '正文疑似为纯导航页面' }
    }
  }
  const tagCount = (body.match(/<[a-z][^>]*>/gi) || []).length
  if (tagCount > 30 && tagCount * 10 > body.length) return { acceptable: false, reason: '正文疑似为未处理的框架载荷' }
  return { acceptable: true }
}

export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
