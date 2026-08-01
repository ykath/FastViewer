import { toString } from 'mdast-util-to-string'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type RenderBlock = {
  id: string
  source: string
  start: number
  end: number
  plainText: string
  textStart: number
  textEnd: number
  estimatedHeight: number
  headingIds: string[]
  headingCountsBefore: Record<string, number>
}

export type SearchIndex = {
  normalized: string
  blocks: Array<{ blockId: string; textStart: number; textEnd: number; normalized: string }>
}

export type RenderPlan = {
  revision: string
  blocks: RenderBlock[]
  headings: Array<{ id: string; text: string; level: number; blockId: string }>
  plainText: string
  searchIndex: SearchIndex
}

const BLOCK_TARGET_SIZE = 64 * 1024
const WORKER_THRESHOLD = 256 * 1024

export async function buildRenderPlan(content: string): Promise<RenderPlan> {
  if (content.length < WORKER_THRESHOLD || typeof Worker === 'undefined') return createRenderPlan(content)
  const worker = new Worker(new URL('./render-plan-worker.ts', import.meta.url), { type: 'module' })
  const id = crypto.randomUUID()
  try {
    return await new Promise<RenderPlan>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent<{ id: string; plan?: RenderPlan; error?: string }>) => {
        if (event.data.id !== id) return
        if (event.data.error || !event.data.plan) reject(new Error(event.data.error ?? '无法生成渲染计划'))
        else resolve(event.data.plan)
      })
      worker.addEventListener('error', (event) => reject(new Error(event.message || '渲染计划 Worker 运行失败')))
      worker.postMessage({ id, content })
    })
  } finally {
    worker.terminate()
  }
}

export function createRenderPlan(content: string): RenderPlan {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(content)
  const children = tree.children
  const blocks: RenderBlock[] = []
  const headings: RenderPlan['headings'] = []
  const usedHeadings = new Map<string, number>()
  let textOffset = 0
  let groupStart = -1
  let groupEnd = -1
  let groupNodes: typeof children = []

  const flush = () => {
    if (groupStart < 0 || groupEnd < groupStart || groupNodes.length === 0) return
    const source = content.slice(groupStart, groupEnd)
    const plainText = groupNodes.map((node) => toString(node)).filter(Boolean).join('')
    const headingCountsBefore = Object.fromEntries(usedHeadings)
    const blockId = `block-${groupStart}`
    const headingIds: string[] = []
    groupNodes.forEach((node) => {
      if (node.type !== 'heading') return
      const text = toString(node)
      const base = slugify(text)
      const count = usedHeadings.get(base) ?? 0
      usedHeadings.set(base, count + 1)
      const headingId = count ? `${base}-${count}` : base
      headingIds.push(headingId)
      headings.push({ id: headingId, text, level: node.depth, blockId })
    })
    blocks.push({
      id: blockId,
      source,
      start: groupStart,
      end: groupEnd,
      plainText,
      textStart: textOffset,
      textEnd: textOffset + plainText.length,
      estimatedHeight: Math.max(72, Math.min(1600, Math.ceil(plainText.length / 52) * 26)),
      headingIds,
      headingCountsBefore,
    })
    textOffset += plainText.length
    groupStart = -1
    groupEnd = -1
    groupNodes = []
  }

  children.forEach((node) => {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? start
    if (groupStart >= 0 && end - groupStart > BLOCK_TARGET_SIZE) flush()
    if (groupStart < 0) groupStart = start
    groupEnd = end
    groupNodes.push(node)
    if (end - groupStart >= BLOCK_TARGET_SIZE) flush()
  })
  flush()

  if (blocks.length === 0) {
    blocks.push({
      id: 'block-0', source: content, start: 0, end: content.length, plainText: content,
      textStart: 0, textEnd: content.length, estimatedHeight: 72, headingIds: [], headingCountsBefore: {},
    })
  }
  const plainText = blocks.map((block) => block.plainText).join('')
  return {
    revision: deterministicHash(content),
    blocks,
    headings,
    plainText,
    searchIndex: {
      normalized: plainText.toLocaleLowerCase(),
      blocks: blocks.map((block) => ({
        blockId: block.id,
        textStart: block.textStart,
        textEnd: block.textEnd,
        normalized: block.plainText.toLocaleLowerCase(),
      })),
    },
  }
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[`*_~()[\]{}:;'"，。！？、]/g, '').trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'heading'
}

function deterministicHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`
}
