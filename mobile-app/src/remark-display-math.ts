import type { Element } from 'hast'
import type { Paragraph, Root } from 'mdast'
import type { Math } from 'mdast-util-math'
import { visit } from 'unist-util-visit'

export default function remarkDisplayMath() {
  return (tree: Root, file: { value: unknown }) => {
    const markdown = String(file.value)
    visit(tree, 'paragraph', (node: Paragraph, index, parent) => {
      if (index === undefined || !parent || node.children.length !== 1) return
      const inlineMath = node.children[0]
      if (inlineMath.type !== 'inlineMath'
        || node.position?.start.offset === undefined
        || node.position.end.offset === undefined) return
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset).trim()
      if (!raw.startsWith('$$') || !raw.endsWith('$$')) return

      const mathCode: Element = {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-math', 'math-display'] },
        children: [{ type: 'text', value: inlineMath.value }],
      }
      const displayMath: Math = {
        type: 'math',
        meta: null,
        value: inlineMath.value,
        position: node.position,
        data: { hName: 'pre', hChildren: [mathCode] },
      }
      parent.children[index] = displayMath
    })
  }
}
