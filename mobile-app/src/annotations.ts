import type { AnnotationAnchor, DocumentAnnotation } from './domain-models'

const CONTEXT_SIZE = 32

export async function sha256Text(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('')
}

export function canonicalText(root: HTMLElement) {
  return textNodes(root).map((node) => node.data).join('')
}

export function captureSelectionAnchor(root: HTMLElement, revision: string, headingId?: string, fullText?: string): AnnotationAnchor | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const nodes = textNodes(root)
  let offset = 0
  let start = -1
  let end = -1
  for (const node of nodes) {
    const positionedOffset = fullText ? progressiveNodeOffset(root, node) : null
    const nodeOffset = positionedOffset ?? offset
    if (node === range.startContainer) start = nodeOffset + range.startOffset
    if (node === range.endContainer) end = nodeOffset + range.endOffset
    offset += node.data.length
  }
  if (start < 0 || end <= start) return null
  const text = fullText ?? nodes.map((node) => node.data).join('')
  const exact = text.slice(start, end)
  if (!exact.trim() || exact.length > 5_000) return null
  return {
    revision,
    start,
    end,
    exact,
    prefix: text.slice(Math.max(0, start - CONTEXT_SIZE), start),
    suffix: text.slice(end, end + CONTEXT_SIZE),
    headingId,
  }
}

export function createBookmarkAnchor(root: HTMLElement, revision: string, headingId?: string, fullText?: string): AnnotationAnchor {
  const text = fullText ?? canonicalText(root)
  const heading = headingId ? root.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)?.textContent ?? '' : ''
  const start = heading ? Math.max(0, text.indexOf(heading)) : 0
  return {
    revision,
    start,
    end: start,
    exact: heading,
    prefix: text.slice(Math.max(0, start - CONTEXT_SIZE), start),
    suffix: text.slice(start + heading.length, start + heading.length + CONTEXT_SIZE),
    headingId,
  }
}

export function reanchorAnnotation(annotation: DocumentAnnotation, text: string, revision: string): DocumentAnnotation {
  const anchor = annotation.anchor
  if (anchor.revision === revision && text.slice(anchor.start, anchor.end) === anchor.exact) return annotation
  if (annotation.kind === 'bookmark' && anchor.headingId) {
    return { ...annotation, anchor: { ...anchor, revision }, status: 'active', updatedAt: new Date().toISOString() }
  }
  const matches: number[] = []
  let cursor = 0
  while (anchor.exact && cursor <= text.length) {
    const index = text.indexOf(anchor.exact, cursor)
    if (index < 0) break
    matches.push(index)
    cursor = index + Math.max(1, anchor.exact.length)
  }
  let best = -1
  let bestScore = -1
  let tied = false
  for (const index of matches) {
    const prefix = text.slice(Math.max(0, index - anchor.prefix.length), index)
    const suffix = text.slice(index + anchor.exact.length, index + anchor.exact.length + anchor.suffix.length)
    const score = commonSuffix(prefix, anchor.prefix) + commonPrefix(suffix, anchor.suffix)
    if (score > bestScore) {
      best = index
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }
  if (best < 0 || tied) {
    return { ...annotation, status: 'orphaned', updatedAt: new Date().toISOString() }
  }
  return {
    ...annotation,
    status: 'active',
    updatedAt: new Date().toISOString(),
    anchor: {
      ...anchor,
      revision,
      start: best,
      end: best + anchor.exact.length,
      prefix: text.slice(Math.max(0, best - CONTEXT_SIZE), best),
      suffix: text.slice(best + anchor.exact.length, best + anchor.exact.length + CONTEXT_SIZE),
    },
  }
}

export function applyAnnotationHighlights(root: HTMLElement, annotations: DocumentAnnotation[]) {
  root.querySelectorAll<HTMLElement>('mark.annotation-highlight').forEach((mark) => mark.replaceWith(...Array.from(mark.childNodes)))
  root.normalize()
  const active = annotations
    .filter((item) => item.status === 'active' && item.kind !== 'bookmark' && item.anchor.end > item.anchor.start)
    .sort((left, right) => right.anchor.start - left.anchor.start)
  for (const annotation of active) applyHighlight(root, annotation)
}

export function annotationsToMarkdown(fileName: string, annotations: DocumentAnnotation[]) {
  const lines = [`# ${fileName} · 批注摘要`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '']
  const sorted = [...annotations].sort((left, right) => left.anchor.start - right.anchor.start)
  for (const item of sorted) {
    lines.push(`## ${item.kind === 'bookmark' ? '书签' : item.kind === 'note' ? '批注' : '高亮'}${item.status === 'orphaned' ? '（待重新关联）' : ''}`)
    if (item.anchor.headingId) lines.push('', `章节：${item.anchor.headingId}`)
    if (item.anchor.exact) lines.push('', `> ${item.anchor.exact.replace(/\n/g, '\n> ')}`)
    if (item.note) lines.push('', item.note)
    lines.push('')
  }
  return lines.join('\n')
}

function applyHighlight(root: HTMLElement, annotation: DocumentAnnotation) {
  const nodes = textNodes(root)
  let offset = 0
  const segments: Array<{ node: Text; start: number; end: number }> = []
  for (const node of nodes) {
    const nodeStart = progressiveNodeOffset(root, node) ?? offset
    const nodeEnd = offset + node.data.length
    const start = Math.max(annotation.anchor.start, nodeStart)
    const end = Math.min(annotation.anchor.end, nodeEnd)
    if (end > start) segments.push({ node, start: start - nodeStart, end: end - nodeStart })
    offset = nodeEnd
  }
  segments.reverse().forEach(({ node, start, end }) => {
    if (node.parentElement?.closest('mark.annotation-highlight')) return
    const selected = node.splitText(start)
    selected.splitText(end - start)
    const mark = document.createElement('mark')
    mark.className = 'annotation-highlight'
    mark.dataset.annotationId = annotation.id
    selected.parentNode?.replaceChild(mark, selected)
    mark.appendChild(selected)
  })
}

function progressiveNodeOffset(root: HTMLElement, node: Text) {
  const block = node.parentElement?.closest<HTMLElement>('[data-text-start]')
  if (!block || !root.contains(block)) return null
  const base = Number(block.dataset.textStart)
  if (!Number.isFinite(base)) return null
  let local = 0
  for (const candidate of textNodes(block)) {
    if (candidate === node) return base + local
    local += candidate.data.length
  }
  return null
}

function textNodes(root: HTMLElement) {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('[data-search-exclude="true"], script, style')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

function commonPrefix(left: string, right: string) {
  let count = 0
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1
  return count
}

function commonSuffix(left: string, right: string) {
  let count = 0
  while (count < left.length && count < right.length && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1
  return count
}
