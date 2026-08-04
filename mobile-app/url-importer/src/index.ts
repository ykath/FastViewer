import { createHash } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { launch, type LaunchedChrome } from 'chrome-launcher'
import WebSocket from 'ws'
import readabilitySource from '@mozilla/readability/Readability.js' with { type: 'text' }
import {
  adapterForUrl,
  articleOutputPath,
  assessQuality,
  formatTimestamp,
  normalizeImportUrl,
  renderMarkdownDocument,
  type AdapterName,
} from './core'
import { renderXSnapshot, type XPageSnapshot } from './x-content'

type Arguments = {
  url: string
  outputRoot: string
  stagingRoot: string
  profileDir: string
  browserPath?: string
  interactive: boolean
  timeoutMs: number
  interactionTimeoutMs: number
}

type ExtractedPage = {
  title: string
  requestedUrl: string
  finalUrl: string
  canonicalUrl?: string
  author?: string
  siteName?: string
  publishedAt?: string
  adapter: AdapterName
  markdown: string
  warnings: string[]
}

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
  sessionId?: string
}

function parseArgs(argv: string[]): Arguments {
  const values = new Map<string, string>()
  let interactive = false
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--interactive') {
      interactive = true
      continue
    }
    if (!key.startsWith('--') || !argv[index + 1]) throw new Error(`无效参数：${key}`)
    values.set(key, argv[index + 1])
    index += 1
  }
  const required = (key: string) => {
    const value = values.get(key)
    if (!value) throw new Error(`缺少参数：${key}`)
    return value
  }
  return {
    url: required('--url'),
    outputRoot: resolve(required('--output-root')),
    stagingRoot: resolve(required('--staging-root')),
    profileDir: resolve(required('--profile-dir')),
    browserPath: values.get('--browser-path'),
    interactive,
    timeoutMs: Number(values.get('--timeout') || 30_000),
    interactionTimeoutMs: Number(values.get('--interaction-timeout') || 600_000),
  }
}

function progress(phase: string, message: string, progressValue: number) {
  process.stderr.write(`EVENT\t${JSON.stringify({ phase, message, progress: progressValue })}\n`)
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function browserCandidates() {
  const env = process.env
  return [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.PROGRAMFILES && join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((value): value is string => Boolean(value))
}

function findBrowser(explicit?: string) {
  if (explicit && existsSync(explicit)) return explicit
  return browserCandidates().find((candidate) => existsSync(candidate))
}

class CdpSession {
  private socket: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  private sessionId = ''
  private targetId = ''

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as CdpMessage
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || 'Chrome DevTools 调用失败'))
        else pending.resolve(message.result)
        return
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {})
      }
    })
  }

  static async open(browserWsUrl: string) {
    const socket = await new Promise<WebSocket>((resolveSocket, reject) => {
      const candidate = new WebSocket(browserWsUrl)
      candidate.once('open', () => resolveSocket(candidate))
      candidate.once('error', reject)
    })
    const session = new CdpSession(socket)
    const created = await session.command<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: false })
    session.targetId = created.targetId
    const attached = await session.command<{ sessionId: string }>('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    session.sessionId = attached.sessionId
    await Promise.all([
      session.pageCommand('Page.enable'),
      session.pageCommand('Runtime.enable'),
      session.pageCommand('Network.enable'),
    ])
    return session
  }

  private command<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const promise = new Promise<T>((resolveCommand, reject) => {
      this.pending.set(id, { resolve: (value) => resolveCommand(value as T), reject })
    })
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return promise
  }

  pageCommand<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    return this.command<T>(method, params, this.sessionId)
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.pageCommand<{ result: { value?: T; description?: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return response.result.value as T
  }

  async navigate(url: string, timeoutMs: number) {
    await this.pageCommand('Page.navigate', { url })
    const startedAt = Date.now()
    let loaded = false
    while (Date.now() - startedAt < timeoutMs) {
      const ready = await this.evaluate<string>('document.readyState').catch(() => '')
      if (ready === 'complete' || ready === 'interactive') {
        loaded = true
        break
      }
      await sleep(150)
    }
    if (!loaded) throw new Error('网页加载超时')
    await sleep(800)
  }

  async scroll() {
    for (let index = 0; index < 5; index += 1) {
      const done = await this.evaluate<boolean>('(() => { const y=scrollY; scrollBy(0, 1400); return scrollY===y || innerHeight+scrollY>=document.body.scrollHeight-4 })()').catch(() => true)
      await sleep(280)
      if (done) break
    }
    await this.evaluate('scrollTo(0, 0)').catch(() => undefined)
  }

  async waitFor(expression: string, timeoutMs: number) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const ready = await this.evaluate<boolean>(expression).catch(() => false)
      if (ready) return true
      await sleep(250)
    }
    return false
  }

  async close() {
    await this.command('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined)
    this.socket.close()
  }
}

async function connectBrowser(options: Arguments) {
  const browserPath = findBrowser(options.browserPath)
  if (!browserPath) throw new Error('未找到 Google Chrome 或 Microsoft Edge')
  await mkdir(options.profileDir, { recursive: true })
  const chrome = await launch({
    chromePath: browserPath,
    userDataDir: options.profileDir,
    chromeFlags: [
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      ...(options.interactive ? [] : ['--headless=new']),
    ],
  })
  const version = await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl: string }
  return { chrome, session: await CdpSession.open(version.webSocketDebuggerUrl), browserPath }
}

async function closeBrowser(chrome: LaunchedChrome | undefined, session: CdpSession | undefined) {
  await session?.close().catch(() => undefined)
  chrome?.kill()
}

function detectGate(title: string, text: string) {
  const sample = `${title}\n${text.slice(0, 5_000)}`
  if (/just a moment|checking your browser|cloudflare/i.test(sample)) return { kind: 'cloudflare', provider: 'Cloudflare', reason: '页面正在进行 Cloudflare 验证' }
  if (/recaptcha|g-recaptcha/i.test(sample)) return { kind: 'recaptcha', provider: 'reCAPTCHA', reason: '页面需要完成 reCAPTCHA' }
  if (/hcaptcha|h-captcha/i.test(sample)) return { kind: 'hcaptcha', provider: 'hCaptcha', reason: '页面需要完成 hCaptcha' }
  if (/captcha|verify you are human|安全验证|人机验证/i.test(sample)) return { kind: 'captcha', provider: '网站', reason: '页面需要完成人机验证' }
  if (/sign in to continue|log in to continue|登录后继续|请先登录/i.test(sample)) return { kind: 'login', provider: '网站', reason: '页面要求登录' }
  return null
}

async function waitForInteraction(session: CdpSession, timeoutMs: number) {
  let resumed = false
  process.stdin.resume()
  process.stdin.once('data', () => { resumed = true })
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (resumed) return
    const snapshot = await session.evaluate<{ title: string; text: string }>('({title:document.title,text:document.body?.innerText||""})').catch(() => ({ title: '', text: '' }))
    if (!detectGate(snapshot.title, snapshot.text)) {
      await sleep(1_000)
      const second = await session.evaluate<{ title: string; text: string }>('({title:document.title,text:document.body?.innerText||""})').catch(() => ({ title: '', text: '' }))
      if (!detectGate(second.title, second.text) && second.text.trim().length > 100) return
    }
    await sleep(1_500)
  }
  throw new Error('等待登录或验证超时')
}

const PAGE_TO_MARKDOWN_SCRIPT = String.raw`(() => {
  const module = { exports: {} };
  ${readabilitySource}
  const meta = (...selectors) => selectors.map((selector) => document.querySelector(selector)?.getAttribute('content')?.trim()).find(Boolean);
  const absolute = (value) => { try { return new URL(value, location.href).toString(); } catch { return value || ''; } };
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const convert = (node) => {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','iframe','noscript','template','svg','nav','footer','aside','form','button'].includes(tag)) return '';
    const children = () => Array.from(node.childNodes).map(convert).join('');
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + clean(node.textContent) + '\n\n';
    if (tag === 'p' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'div') return '\n\n' + children() + '\n\n';
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return '**' + children().trim() + '**';
    if (tag === 'em' || tag === 'i') return '*' + children().trim() + '*';
    if (tag === 'del' || tag === 's') return '~~' + children().trim() + '~~';
    if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return String.fromCharCode(96) + clean(node.textContent) + String.fromCharCode(96);
    if (tag === 'pre') return '\n\n' + String.fromCharCode(96).repeat(3) + '\n' + (node.textContent || '').trimEnd() + '\n' + String.fromCharCode(96).repeat(3) + '\n\n';
    if (tag === 'blockquote') return '\n\n' + (node.textContent || '').trim().split(/\r?\n/).map((line) => '> ' + line).join('\n') + '\n\n';
    if (tag === 'a') { const text = clean(node.textContent) || absolute(node.getAttribute('href')); return '[' + text + '](' + absolute(node.getAttribute('href')) + ')'; }
    if (tag === 'img') { const source = node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src'); return source ? '![' + clean(node.getAttribute('alt')) + '](' + absolute(source) + ')' : ''; }
    if (tag === 'li') { const ordered = node.parentElement?.tagName.toLowerCase() === 'ol'; const checkbox = node.querySelector(':scope > input[type="checkbox"]'); const index = ordered ? Array.from(node.parentElement.children).indexOf(node) + 1 + '. ' : checkbox ? '- [' + (checkbox.checked ? 'x' : ' ') + '] ' : '- '; return '\n' + index + children().trim(); }
    if (tag === 'ul' || tag === 'ol') return '\n' + children() + '\n';
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll(':scope > th,:scope > td')).map((cell) => clean(cell.textContent).replace(/\|/g, '\\|'))).filter((row) => row.length);
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.length));
      const padded = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
      return '\n\n| ' + padded[0].join(' | ') + ' |\n| ' + Array(width).fill('---').join(' | ') + ' |\n' + padded.slice(1).map((row) => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
    }
    if (tag === 'video') { const source = node.currentSrc || node.getAttribute('src') || node.querySelector('source')?.getAttribute('src'); const poster = node.getAttribute('poster'); return (poster ? '\n\n![视频封面](' + absolute(poster) + ')\n\n' : '\n\n') + (source ? '[视频](' + absolute(source) + ')' : '') + '\n\n'; }
    if (tag === 'hr') return '\n\n---\n\n';
    return children();
  };
  let readable = null;
  try { readable = new module.exports(document.cloneNode(true), { charThreshold: 120 }).parse(); } catch {}
  const fallbackSource = document.querySelector('article') || document.querySelector('main') || document.body;
  const root = readable?.content ? new DOMParser().parseFromString(readable.content, 'text/html').body : fallbackSource?.cloneNode(true);
  root?.querySelectorAll('[hidden],[aria-hidden="true"],.advertisement,.ads,.cookie,.newsletter,.social-share').forEach((item) => item.remove());
  const markdown = convert(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: readable?.title || meta('meta[property="og:title"]','meta[name="twitter:title"]') || clean(document.querySelector('h1')?.textContent) || document.title || location.href,
    canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || meta('meta[property="og:url"]'),
    author: readable?.byline || meta('meta[name="author"]','meta[property="article:author"]','meta[name="twitter:creator"]'),
    siteName: readable?.siteName || meta('meta[property="og:site_name"]','meta[name="application-name"]'),
    publishedAt: readable?.publishedTime || document.querySelector('time[datetime]')?.getAttribute('datetime') || meta('meta[property="article:published_time"]','meta[name="date"]'),
    markdown
  };
})()`

async function extractGeneric(session: CdpSession, finalUrl: string) {
  const local = await session.evaluate<{ title: string; canonicalUrl?: string; author?: string; siteName?: string; publishedAt?: string; markdown: string }>(PAGE_TO_MARKDOWN_SCRIPT)
  let markdown = local.markdown || ''
  const warnings: string[] = []
  if (markdown.length < 120) {
    try {
      const response = await fetch(`https://defuddle.md/${encodeURIComponent(finalUrl)}`, { headers: { accept: 'text/markdown,text/plain;q=0.9' }, redirect: 'follow' })
      if (response.ok) {
        const remote = (await response.text()).replace(/^---[\s\S]*?---\s*/, '').trim()
        if (remote.length > markdown.length) {
          markdown = remote
          warnings.push('本地正文不足，已使用 Defuddle 回退')
        }
      }
    } catch {
      // Keep the local result and let the quality gate decide.
    }
  }
  return { ...local, markdown, warnings }
}

async function extractHackerNews(session: CdpSession) {
  return session.evaluate<{ title: string; canonicalUrl: string; siteName: string; markdown: string; warnings: string[] }>(String.raw`(() => {
    const title = document.querySelector('.titleline > a')?.textContent?.trim() || document.title || 'Hacker News';
    const storyUrl = document.querySelector('.titleline > a')?.href || location.href;
    const subtext = document.querySelector('.subtext')?.textContent?.replace(/\s+/g,' ').trim();
    const sections = ['# ' + title, '', '[原文](' + storyUrl + ')', subtext ? '\n' + subtext : '', '', '## 评论'];
    for (const row of Array.from(document.querySelectorAll('tr.comtr'))) {
      const depth = Math.max(0, Math.round(Number(row.querySelector('td.ind img')?.getAttribute('width') || 0) / 40));
      const author = row.querySelector('.hnuser')?.textContent?.trim() || '[deleted]';
      const age = row.querySelector('.age')?.textContent?.trim() || '';
      const comment = row.querySelector('.commtext')?.textContent?.replace(/\s+/g,' ').trim() || '*[deleted]*';
      sections.push('', '  '.repeat(depth) + '**' + author + '** ' + age, '> '.repeat(depth + 1) + comment);
    }
    return { title, canonicalUrl: location.href, siteName: 'Hacker News', markdown: sections.join('\n').trim(), warnings: [] };
  })()`)
}

const X_READY_SCRIPT = String.raw`(() => {
  const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1];
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"],article'));
  const tweet = statusId
    ? articles.find((article) => article.getAttribute('data-tweet-id') === statusId || article.querySelector('a[href*="/status/' + statusId + '"]'))
    : articles[0];
  return Boolean(tweet?.querySelector('[data-testid="tweetText"],[dir="auto"],meta[itemprop="articleBody"],[data-testid="tweetPhoto"] img,a[aria-label="Image"] img,video[poster],[data-testid^="card.layout"] img,[itemtype$="/ImageObject"] meta[itemprop="contentUrl"]'));
})()`

async function extractX(session: CdpSession) {
  const snapshot = await session.evaluate<XPageSnapshot>(String.raw`(() => {
    const meta = (...selectors) => selectors.map((selector) => document.querySelector(selector)?.getAttribute('content')?.trim()).find(Boolean);
    const targetStatusId = location.pathname.match(/\/status\/(\d+)/)?.[1];
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"],article'));
    const exactTweet = targetStatusId
      ? articles.find((article) => article.getAttribute('data-tweet-id') === targetStatusId || article.querySelector('a[href*="/status/' + targetStatusId + '"]'))
      : articles[0];
    const tweet = exactTweet || (!targetStatusId ? articles[0] : null);
    const userName = tweet?.querySelector('[data-testid="User-Name"]');
    const schemaAuthor = tweet?.querySelector('[itemprop="author"]');
    const schemaName = schemaAuthor?.querySelector('meta[itemprop="name"]')?.getAttribute('content') || '';
    const schemaHandle = schemaAuthor?.querySelector('meta[itemprop="alternateName"]')?.getAttribute('content') || '';
    const user = (userName?.innerText || userName?.textContent || [schemaName, schemaHandle ? '@' + schemaHandle.replace(/^@/, '') : ''].filter(Boolean).join(' ') || '').replace(/\s+/g, ' ').trim();
    const profileLink = Array.from(userName?.querySelectorAll('a[href]') || []).find((link) => /^\/[A-Za-z0-9_]+$/.test(link.getAttribute('href') || ''));
    const schemaProfile = schemaAuthor?.querySelector('meta[itemprop="url"]')?.getAttribute('content');
    const time = tweet?.querySelector('time')?.getAttribute('datetime') || tweet?.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') || undefined;
    const textElement = tweet?.querySelector('[data-testid="tweetText"]');
    const schemaText = tweet?.querySelector('meta[itemprop="articleBody"]')?.getAttribute('content') || '';
    const visibleCandidates = Array.from(tweet?.querySelectorAll('[dir="auto"]') || [])
      .map((element) => element.innerText || element.textContent || '')
      .filter(Boolean);
    const schemaPrefix = schemaText.slice(0, Math.min(80, schemaText.length));
    const visibleText = (schemaPrefix ? visibleCandidates.find((value) => value.startsWith(schemaPrefix)) : '')
      || visibleCandidates.sort((left, right) => right.length - left.length)[0]
      || '';
    const text = textElement?.innerText || textElement?.textContent || visibleText || schemaText;
    const selectedMedia = tweet
      ? [
          ...Array.from(tweet.querySelectorAll('[itemtype$="/ImageObject"] meta[itemprop="contentUrl"]')),
          ...Array.from(tweet.querySelectorAll('[data-testid="tweetPhoto"] img,[data-testid^="card.layout"] img,a[aria-label="Image"] img,video[poster]')),
        ]
      : [];
    const media = selectedMedia.flatMap((element) => {
      if (element.tagName.toLowerCase() === 'video') {
        const source = element.getAttribute('poster');
        return source ? [{ source, alt: '视频封面', kind: 'videoPoster' }] : [];
      }
      if (element.tagName.toLowerCase() === 'meta') {
        const source = element.getAttribute('content');
        const imageObject = element.closest('[itemtype$="/ImageObject"]');
        const alt = imageObject?.querySelector('meta[itemprop="name"]')?.getAttribute('content') || '推文图片';
        return source ? [{ source, alt, kind: 'image' }] : [];
      }
      const srcset = element.getAttribute('srcset');
      const largestSrcset = srcset?.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean).at(-1);
      const source = largestSrcset || element.currentSrc || element.getAttribute('src');
      return source ? [{ source, alt: element.getAttribute('alt') || '推文图片', kind: 'image' }] : [];
    });
    return {
      title: meta('meta[property="og:title"]','meta[name="twitter:title"]') || document.title || 'X 内容',
      canonicalUrl: location.href,
      author: profileLink ? new URL(profileLink.getAttribute('href'), location.href).toString() : schemaProfile || meta('meta[name="twitter:creator"]'),
      siteName: 'X',
      publishedAt: time,
      targetStatusId,
      targetMatched: Boolean(exactTweet),
      user,
      text,
      media,
    };
  })()`)
  return renderXSnapshot(snapshot)
}

type PlayerResponse = {
  videoDetails?: { title?: string; shortDescription?: string; author?: string; videoId?: string }
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; ownerChannelName?: string } }
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl?: string; languageCode?: string; name?: { simpleText?: string } }> } }
}

async function extractYouTube(session: CdpSession, finalUrl: string) {
  const fallback = await session.evaluate<{ title: string; author?: string }>('({title:document.querySelector(\'meta[property="og:title"]\')?.content||document.title||location.href,author:document.querySelector(\'meta[name="author"]\')?.content})')
  const player = await session.evaluate<PlayerResponse | null>('window.ytInitialPlayerResponse || null').catch(() => null)
  const details = player?.videoDetails
  const title = details?.title || fallback.title || 'YouTube 视频'
  const author = details?.author || player?.microformat?.playerMicroformatRenderer?.ownerChannelName
  const sections = [`[在 YouTube 打开视频](${finalUrl})`, details?.shortDescription?.trim() || '']
  const warnings: string[] = []
  const track = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]
  if (track?.baseUrl) {
    try {
      const captionUrl = new URL(track.baseUrl)
      captionUrl.searchParams.set('fmt', 'json3')
      const payload = await fetch(captionUrl).then((response) => response.json()) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }
      const transcript = (payload.events || []).flatMap((event) => {
        const text = (event.segs || []).map((segment) => segment.utf8 || '').join('').replace(/\s+/g, ' ').trim()
        return text ? [`[${formatTimestamp((event.tStartMs || 0) / 1000)}] ${text}`] : []
      })
      if (transcript.length) sections.push('', '## 字幕', '', ...transcript)
      else warnings.push('字幕轨道为空，已保存视频描述')
    } catch {
      warnings.push('字幕下载失败，已保存视频描述')
    }
  } else {
    warnings.push('该视频没有可用字幕，已保存视频描述')
  }
  const videoId = details?.videoId
  if (videoId) sections.unshift(`![视频封面](https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg)`, '')
  return {
    title,
    author,
    canonicalUrl: finalUrl,
    siteName: 'YouTube',
    publishedAt: player?.microformat?.playerMicroformatRenderer?.publishDate,
    markdown: sections.join('\n').trim(),
    warnings,
  }
}

async function fetchImagePayload(url: string, maxBytes: number, session?: CdpSession) {
  let directError: unknown
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength > maxBytes) throw new Error('图片超过本地化大小限制')
    return {
      contentType: response.headers.get('content-type') || '',
      declaredLength,
      bytes: new Uint8Array(await response.arrayBuffer()),
    }
  } catch (error) {
    directError = error
  }

  if (!session) throw directError
  const browserResult = await session.evaluate<{ ok: boolean; status?: number; contentType?: string; declaredLength?: number; base64?: string; error?: string }>(String.raw`(async () => {
    try {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'omit', redirect: 'follow' });
      if (!response.ok) return { ok: false, status: response.status, error: 'HTTP ' + response.status };
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > ${maxBytes}) return { ok: false, error: '图片超过本地化大小限制' };
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return {
        ok: true,
        contentType: response.headers.get('content-type') || '',
        declaredLength,
        base64: btoa(binary),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`)
  if (!browserResult?.ok || typeof browserResult.base64 !== 'string') {
    const directMessage = directError instanceof Error ? directError.message : String(directError || '下载失败')
    throw new Error(`${directMessage}；浏览器回退失败：${browserResult?.error || browserResult?.status || '未知错误'}`)
  }
  return {
    contentType: browserResult.contentType || '',
    declaredLength: browserResult.declaredLength || 0,
    bytes: new Uint8Array(Buffer.from(browserResult.base64, 'base64')),
  }
}

async function downloadImages(markdown: string, pageUrl: string, articleDirectory: string, session?: CdpSession) {
  const pattern = /!\[([^\]]*)]\((?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+["'][^"'\r\n]*["'])?\)/g
  const allMatches = Array.from(markdown.matchAll(pattern))
  const matches = allMatches.slice(0, 64)
  const warnings: string[] = allMatches.length > 64 ? [`网页包含 ${allMatches.length} 张图片，仅本地化前 64 张`] : []
  if (!matches.length) return { markdown, downloadedImages: 0, warnings }
  const imageDirectory = join(articleDirectory, 'imgs')
  await mkdir(imageDirectory, { recursive: true })
  let totalBytes = 0
  let downloadedImages = 0
  let rewritten = markdown
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const rawUrl = match[2] || match[3]
    try {
      const resolvedUrl = new URL(rawUrl, pageUrl)
      if (!/^https?:$/.test(resolvedUrl.protocol)) continue
      const payload = await fetchImagePayload(resolvedUrl.toString(), Math.min(20 * 1024 * 1024, 64 * 1024 * 1024 - totalBytes), session)
      const contentType = payload.contentType
      const sourceExtension = extname(resolvedUrl.pathname).toLowerCase()
      if (!contentType.toLowerCase().startsWith('image/') && !/^\.(png|jpe?g|gif|webp)$/i.test(sourceExtension)) {
        throw new Error('响应不是支持的图片格式')
      }
      if (/svg|avif|bmp|tiff/i.test(contentType) || /^\.(svg|avif|bmp|tiff?)$/i.test(sourceExtension)) {
        throw new Error('图片格式不支持本地化')
      }
      const declaredLength = payload.declaredLength
      if (declaredLength > 20 * 1024 * 1024 || totalBytes + declaredLength > 64 * 1024 * 1024) {
        throw new Error('图片超过本地化大小限制')
      }
      const bytes = payload.bytes
      if (bytes.length > 20 * 1024 * 1024 || totalBytes + bytes.length > 64 * 1024 * 1024) throw new Error('图片超过本地化大小限制')
      const extension = /^\.(png|jpe?g|gif|webp)$/i.test(sourceExtension)
        ? sourceExtension.replace('.jpeg', '.jpg')
        : contentType.includes('png') ? '.png' : contentType.includes('gif') ? '.gif' : contentType.includes('webp') ? '.webp' : '.jpg'
      const digest = createHash('sha256').update(resolvedUrl.toString()).digest('hex').slice(0, 10)
      const fileName = `${String(index + 1).padStart(2, '0')}-${digest}${extension}`
      await writeFile(join(imageDirectory, fileName), bytes)
      const localized = `![${match[1]}](imgs/${fileName})`
      rewritten = rewritten.replace(match[0], localized)
      totalBytes += bytes.length
      downloadedImages += 1
    } catch (error) {
      warnings.push(`图片未能本地化：${rawUrl}（${error instanceof Error ? error.message : '下载失败'}）`)
    }
  }
  if (!downloadedImages) await rm(imageDirectory, { recursive: true, force: true })
  return { markdown: rewritten, downloadedImages, warnings }
}

async function run(options: Arguments) {
  const requested = normalizeImportUrl(options.url)
  let adapter = adapterForUrl(requested)
  progress('browser', '正在启动抓取浏览器', 5)
  let chrome: LaunchedChrome | undefined
  let session: CdpSession | undefined
  try {
    const connected = await connectBrowser(options)
    chrome = connected.chrome
    session = connected.session
    progress('loading', `正在加载 ${requested.hostname}`, 15)
    await session.navigate(requested.toString(), options.timeoutMs)
    await session.scroll()
    if (adapter === 'x') await session.waitFor(X_READY_SCRIPT, Math.min(options.timeoutMs, 12_000))
    const initial = await session.evaluate<{ title: string; text: string; url: string }>('({title:document.title,text:document.body?.innerText||"",url:location.href})')
    if (/ERR_[A-Z_]+|This site can.?t be reached|无法访问此网站|网页无法打开|DNS_PROBE_/i.test(`${initial.title}\n${initial.text}`)) {
      throw new Error('网络请求失败，网页无法访问')
    }
    const gate = detectGate(initial.title, initial.text)
    if (gate && !options.interactive) {
      return { status: 'needsInteraction', interaction: gate, requestedUrl: requested.toString(), adapter }
    }
    if (options.interactive) {
      progress('interaction', '请在浏览器中完成登录或验证，然后返回 LightPage 继续', 25)
      await waitForInteraction(session, options.interactionTimeoutMs)
      await session.scroll()
      if (adapter === 'x') await session.waitFor(X_READY_SCRIPT, Math.min(options.timeoutMs, 12_000))
    }

    progress('extracting', `正在使用 ${adapter} 适配器提取正文`, 40)
    const finalUrl = await session.evaluate<string>('location.href')
    let extracted: Omit<ExtractedPage, 'requestedUrl' | 'finalUrl' | 'adapter'>
    if (adapter === 'hn') extracted = await extractHackerNews(session)
    else if (adapter === 'youtube') extracted = await extractYouTube(session, finalUrl)
    else if (adapter === 'x') extracted = await extractX(session)
    else extracted = await extractGeneric(session, finalUrl)

    let page: ExtractedPage = { ...extracted, requestedUrl: requested.toString(), finalUrl, adapter }
    progress('validating', '正在校验标题、正文和页面质量', 60)
    let quality = assessQuality(page.markdown, page.title, adapter)
    if (!quality.acceptable && adapter !== 'generic') {
      const adapterWarnings = page.warnings
      const fallback = await extractGeneric(session, finalUrl)
      const fallbackQuality = assessQuality(fallback.markdown, fallback.title, 'generic')
      if (fallbackQuality.acceptable) {
        const failedAdapter = adapter
        adapter = 'generic'
        page = {
          ...fallback,
          requestedUrl: requested.toString(),
          finalUrl,
          adapter,
          warnings: [
            ...adapterWarnings,
            ...fallback.warnings,
            `${failedAdapter} 专项提取未通过质量校验（${quality.reason || '原因未知'}），已回退通用正文提取`,
          ],
        }
        quality = fallbackQuality
      }
    }
    if (!quality.acceptable && !options.interactive) {
      return {
        status: 'needsInteraction',
        interaction: { kind: 'quality', provider: page.siteName || requested.hostname, reason: quality.reason || '抓取质量可疑' },
        requestedUrl: requested.toString(),
        adapter,
      }
    }
    if (!quality.acceptable) throw new Error(quality.reason || '未能提取有效正文')

    const stagingDirectory = join(options.stagingRoot, `url-import-${process.pid}-${Date.now()}`)
    await mkdir(stagingDirectory, { recursive: true })
    const output = articleOutputPath(options.outputRoot, requested, page.title)
    try {
      progress('media', '正在下载网页图片', 75)
      const localized = await downloadImages(page.markdown, page.finalUrl, stagingDirectory, session)
      const warnings = [...page.warnings, ...localized.warnings]
      const documentMarkdown = renderMarkdownDocument({
        title: page.title,
        requestedUrl: page.requestedUrl,
        canonicalUrl: page.canonicalUrl || page.finalUrl,
        author: page.author,
        siteName: page.siteName,
        publishedAt: page.publishedAt,
        adapter,
        warnings,
        markdown: localized.markdown,
      })
      progress('saving', '正在保存本地 Markdown 快照', 90)
      const stagingMarkdown = join(stagingDirectory, basename(output.markdownPath))
      await writeFile(stagingMarkdown, documentMarkdown, 'utf8')
      await mkdir(dirname(output.directory), { recursive: true })
      const outputMarkdown = join(output.directory, basename(output.markdownPath))
      let ownsDestination = false
      try {
        await mkdir(output.directory)
        ownsDestination = true
        await cp(stagingMarkdown, outputMarkdown, { force: false, errorOnExist: true })
        const stagingImages = join(stagingDirectory, 'imgs')
        if (existsSync(stagingImages)) {
          await cp(stagingImages, join(output.directory, 'imgs'), { recursive: true, force: false, errorOnExist: true })
        }
      } catch (error) {
        if (ownsDestination) await rm(output.directory, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      progress('complete', '网页已转换为本地 Markdown', 100)
      return {
        status: 'ok',
        requestedUrl: requested.toString(),
        canonicalUrl: page.canonicalUrl || page.finalUrl,
        adapter,
        title: page.title,
        outputPath: outputMarkdown,
        downloadedImages: localized.downloadedImages,
        warnings,
      }
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    await closeBrowser(chrome, session)
  }
}

async function main() {
  try {
    const result = await run(parseArgs(process.argv))
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = /有效的网页 URL|仅支持 http/i.test(message) ? 'INVALID_URL'
      : /Chrome|Edge/.test(message) ? 'BROWSER_NOT_FOUND'
        : /超时|timeout/i.test(message) ? 'TIMEOUT'
          : /网络请求失败|ENOTFOUND|ECONN|fetch failed/i.test(message) ? 'NETWORK_ERROR'
            : /ENOSPC|EACCES|EPERM|磁盘/.test(message) ? 'WRITE_FAILED'
              : 'EXTRACTION_FAILED'
    process.stdout.write(JSON.stringify({ status: 'failed', code, message, retryable: code !== 'WRITE_FAILED' }))
  }
}

void main()
