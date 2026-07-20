import { toText } from 'hast-util-to-text'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import { createLowlight } from 'lowlight'
import { visit } from 'unist-util-visit'
import type { Element, ElementContent, Root } from 'hast'

const lowlight = createLowlight({
  bash,
  css,
  java,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
})

lowlight.registerAlias({
  bash: ['sh', 'shell'],
  javascript: ['js', 'jsx'],
  markdown: ['md'],
  typescript: ['ts', 'tsx'],
  xml: ['html', 'svg'],
})

export default function rehypeCodeHighlight() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, _index, parent) => {
      if (node.tagName !== 'code' || parent?.type !== 'element' || parent.tagName !== 'pre') return
      const classes = Array.isArray(node.properties.className)
        ? node.properties.className.map(String)
        : []
      const language = classes
        .map((className) => /^lang(?:uage)?-(.+)$/.exec(className)?.[1])
        .find(Boolean)
      if (!language || !lowlight.registered(language)) return
      const result = lowlight.highlight(language, toText(node))
      node.children = result.children as ElementContent[]
      node.properties.className = [...classes, 'hljs', `language-${language}`]
    })
  }
}
