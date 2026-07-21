import { toText } from 'hast-util-to-text'
import { describe, expect, it } from 'vitest'
import type { Element, Root } from 'hast'
import rehypeCodeHighlight from './rehype-code-highlight'

describe('代码高亮', () => {
  it('保留多行 Python 的换行、空行和缩进', () => {
    const source = 'def hello():\n    print("hello")\n\nhello()\n'
    const code: Element = {
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-python'] },
      children: [{ type: 'text', value: source }],
    }
    const tree: Root = {
      type: 'root',
      children: [{ type: 'element', tagName: 'pre', properties: {}, children: [code] }],
    }

    rehypeCodeHighlight()(tree)

    expect(toText(code, { whitespace: 'pre' })).toBe(source)
    expect(code.properties.className).toContain('hljs')
  })

  it('不修改未注册语言的代码内容', () => {
    const source = 'first\n  second\n'
    const code: Element = {
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-unknown'] },
      children: [{ type: 'text', value: source }],
    }
    const tree: Root = {
      type: 'root',
      children: [{ type: 'element', tagName: 'pre', properties: {}, children: [code] }],
    }

    rehypeCodeHighlight()(tree)

    expect(toText(code, { whitespace: 'pre' })).toBe(source)
    expect(code.properties.className).toEqual(['language-unknown'])
  })
})
