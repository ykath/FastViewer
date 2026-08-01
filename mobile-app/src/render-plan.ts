import { toString } from 'mdast-util-to-string'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type RenderBlock = {
  id: string
  structuralKey: string
  revision: string
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
const SCANNER_THRESHOLD = 1024 * 1024

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
  if (content.length >= SCANNER_THRESHOLD) return createScannedRenderPlan(content)
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(content)
  const children = tree.children
  const blocks: RenderBlock[] = []
  const headings: RenderPlan['headings'] = []
  const usedHeadings = new Map<string, number>()
  let textOffset = 0
  let groupStart = 0
  let groupNodes: typeof children = []

  const flush = (sourceEnd: number) => {
    if (groupNodes.length === 0 || sourceEnd < groupStart) return
    const source = content.slice(groupStart, sourceEnd)
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
      structuralKey: blockId,
      revision: deterministicHash(source),
      source,
      start: groupStart,
      end: sourceEnd,
      plainText,
      textStart: textOffset,
      textEnd: textOffset + plainText.length,
      estimatedHeight: Math.max(72, Math.min(1600, Math.ceil(plainText.length / 52) * 26)),
      headingIds,
      headingCountsBefore,
    })
    textOffset += plainText.length
    groupStart = sourceEnd
    groupNodes = []
  }

  children.forEach((node) => {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? start
    // Flush before the next AST node so Markdown syntax is never split. The
    // inter-node whitespace remains in the preceding block, preserving every
    // source byte and the original line structure.
    if (groupNodes.length > 0 && end - groupStart > BLOCK_TARGET_SIZE) flush(start)
    groupNodes.push(node)
  })
  flush(content.length)

  if (blocks.length === 0) {
    blocks.push({
      id: 'block-0', structuralKey: 'block-0', revision: deterministicHash(content), source: content, start: 0, end: content.length, plainText: content,
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

function createScannedRenderPlan(content: string): RenderPlan {
  const boundaries = scanSafeBoundaries(content)
  const blocks: RenderBlock[] = []
  const headings: RenderPlan['headings'] = []
  const usedHeadings = new Map<string, number>()
  const usedStructures = new Map<string, number>()
  let textOffset = 0

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]
    const end = boundaries[index + 1]
    const source = content.slice(start, end)
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source)
    const plainText = tree.children.map((node) => toString(node)).filter(Boolean).join('')
    const headingCountsBefore = Object.fromEntries(usedHeadings)
    const headingIds: string[] = []
    let firstHeading = ''
    tree.children.forEach((node) => {
      if (node.type !== 'heading') return
      const text = toString(node)
      const base = slugify(text)
      const count = usedHeadings.get(base) ?? 0
      usedHeadings.set(base, count + 1)
      const headingId = count ? `${base}-${count}` : base
      if (!firstHeading) firstHeading = headingId
      headingIds.push(headingId)
      headings.push({ id: headingId, text, level: node.depth, blockId: '' })
    })
    const baseStructure = firstHeading ? `heading:${firstHeading}` : index === 0 ? 'preamble' : `continuation:${index}`
    const structureCount = usedStructures.get(baseStructure) ?? 0
    usedStructures.set(baseStructure, structureCount + 1)
    const structuralKey = structureCount ? `${baseStructure}:${structureCount}` : baseStructure
    const blockId = `block-${deterministicHash(structuralKey)}`
    for (let headingIndex = headings.length - headingIds.length; headingIndex < headings.length; headingIndex += 1) {
      if (headingIndex >= 0) headings[headingIndex].blockId = blockId
    }
    blocks.push({
      id: blockId,
      structuralKey,
      revision: deterministicHash(source),
      source,
      start,
      end,
      plainText,
      textStart: textOffset,
      textEnd: textOffset + plainText.length,
      estimatedHeight: Math.max(72, Math.min(1600, Math.ceil(plainText.length / 52) * 26)),
      headingIds,
      headingCountsBefore,
    })
    textOffset += plainText.length
  }
  const plainText = blocks.map((block) => block.plainText).join('')
  return {
    revision: deterministicHash(content),
    blocks,
    headings,
    plainText,
    searchIndex: {
      normalized: plainText.toLocaleLowerCase(),
      blocks: blocks.map((block) => ({ blockId: block.id, textStart: block.textStart, textEnd: block.textEnd, normalized: block.plainText.toLocaleLowerCase() })),
    },
  }
}

function scanSafeBoundaries(content: string) {
  const boundaries = [0]
  let blockStart = 0
  let offset = 0
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (const line of content.matchAll(/.*(?:\r?\n|$)/g)) {
    const source = line[0]
    if (!source) continue
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(source)
    if (!fence && fenceMatch) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length }
    } else if (fence && fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      const trailing = fenceMatch[2]
      if (marker === fence.marker && fenceMatch[1].length >= fence.length && /^\s*$/.test(trailing)) {
        fence = null
      }
    }
    const isHeading = !fence && /^ {0,3}#{1,6}\s+\S/.test(source)
    const isBlank = !fence && /^\s*$/.test(source)
    if (offset > blockStart && isHeading) {
      boundaries.push(offset)
      blockStart = offset
    } else if (offset - blockStart >= BLOCK_TARGET_SIZE && isBlank) {
      const next = offset + source.length
      boundaries.push(next)
      blockStart = next
    }
    offset += source.length
  }
  if (boundaries.at(-1) !== content.length) boundaries.push(content.length)
  return boundaries.filter((value, index, values) => index === 0 || value > values[index - 1])
}

export function reconcileRenderPlans(previous: RenderPlan | null, next: RenderPlan): RenderPlan {
  if (!previous) return next
  const previousBlocks = new Map(previous.blocks.map((block) => [`${block.structuralKey}:${block.revision}`, block]))
  const blocks = next.blocks.map((block) => {
    const existing = previousBlocks.get(`${block.structuralKey}:${block.revision}`)
    return existing ? { ...block, id: existing.id } : block
  })
  const idByStructure = new Map(blocks.map((block) => [block.structuralKey, block.id]))
  return {
    ...next,
    blocks,
    headings: next.headings.map((heading) => {
      const block = blocks.find((item) => item.headingIds.includes(heading.id))
      return block ? { ...heading, blockId: idByStructure.get(block.structuralKey) ?? block.id } : heading
    }),
    searchIndex: {
      ...next.searchIndex,
      blocks: next.searchIndex.blocks.map((item, index) => ({ ...item, blockId: blocks[index]?.id ?? item.blockId })),
    },
  }
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[`*_~()[\]{}:;'"，。！？、]/g, '').trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'heading'
}

export function deterministicHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`
}
