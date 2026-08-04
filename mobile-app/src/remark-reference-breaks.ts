import type { Paragraph, PhrasingContent, Root } from 'mdast'
import { visit } from 'unist-util-visit'

const REFERENCE_ENTRY_START = /^\[\d+\](?:[ \t]+|$)/
const NEXT_REFERENCE_ENTRY = /\r?\n(?=\[\d+\](?:[ \t]+|$))/g

/**
 * Preserve source line breaks between consecutive numeric bibliography entries.
 * CommonMark treats those line breaks as spaces because `[1] ...` is not list syntax.
 * Limiting the extension to paragraphs that start with a numeric reference keeps
 * ordinary prose soft-break behavior unchanged.
 */
export default function remarkReferenceBreaks() {
  return (tree: Root) => {
    visit(tree, 'paragraph', (node: Paragraph) => {
      const firstChild = node.children[0]
      if (firstChild?.type !== 'text' || !REFERENCE_ENTRY_START.test(firstChild.value)) return

      node.children = node.children.flatMap<PhrasingContent>((child) => {
        if (child.type !== 'text') return [child]
        const parts = child.value.split(NEXT_REFERENCE_ENTRY)
        if (parts.length === 1) return [child]
        return parts.flatMap<PhrasingContent>((value, index) => {
          const result: PhrasingContent[] = []
          if (index > 0) result.push({ type: 'break' })
          if (value) result.push({ type: 'text', value })
          return result
        })
      })
    })
  }
}
