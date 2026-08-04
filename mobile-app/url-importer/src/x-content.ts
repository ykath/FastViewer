export type XMediaSnapshot = {
  source: string
  alt?: string
  kind?: 'image' | 'videoPoster'
}

export type XPageSnapshot = {
  title: string
  canonicalUrl?: string
  author?: string
  siteName?: string
  publishedAt?: string
  targetStatusId?: string
  targetMatched: boolean
  user?: string
  text?: string
  media: XMediaSnapshot[]
}

export function normalizeXText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0 ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function xTextToMarkdown(value: string): string {
  return normalizeXText(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').join('  \n'))
    .join('\n\n')
}

export function normalizeXMediaUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() === 'pbs.twimg.com' && url.pathname.startsWith('/media/') && !/\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) {
      url.searchParams.set('name', 'orig')
    }
    return url.toString()
  } catch {
    return value
  }
}

function xMediaIdentity(value: string) {
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) {
      return `${url.hostname}${url.pathname.replace(/\.(?:png|jpe?g|gif|webp)$/i, '')}`.toLowerCase()
    }
    return url.toString()
  } catch {
    return value
  }
}

function markdownAlt(value: string) {
  return normalizeXText(value).replaceAll('[', '').replaceAll(']', '').replace(/\n/g, ' ').trim()
}

export function renderXSnapshot(snapshot: XPageSnapshot) {
  const warnings: string[] = []
  if (snapshot.targetStatusId && !snapshot.targetMatched) {
    warnings.push(`未在页面 DOM 中找到目标推文 ${snapshot.targetStatusId}`)
  }

  const sections: string[] = []
  const text = xTextToMarkdown(snapshot.text || '')
  const media = snapshot.media
    .map((item) => ({ ...item, source: normalizeXMediaUrl(item.source) }))
    .filter((item) => /^https?:\/\//i.test(item.source) && !/profile_images|emoji/i.test(item.source))
    .filter((item, index, items) => items.findIndex((candidate) => xMediaIdentity(candidate.source) === xMediaIdentity(item.source)) === index)

  if (text || media.length) {
    const heading = snapshot.user?.trim() || snapshot.author?.trim() || 'X 用户'
    sections.push(`## ${heading}${snapshot.publishedAt ? ` · ${snapshot.publishedAt}` : ''}`)
    if (text) sections.push('', text)
    for (const item of media) {
      const fallbackAlt = item.kind === 'videoPoster' ? '视频封面' : '推文图片'
      sections.push('', `![${markdownAlt(item.alt || fallbackAlt)}](<${item.source}>)`)
    }
  }

  if (!text && !media.length) warnings.push('目标推文正文和媒体均未加载')

  return {
    title: snapshot.title,
    canonicalUrl: snapshot.canonicalUrl,
    author: snapshot.author,
    siteName: snapshot.siteName || 'X',
    publishedAt: snapshot.publishedAt,
    markdown: sections.join('\n').trim(),
    warnings,
  }
}
