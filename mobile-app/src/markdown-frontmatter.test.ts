import { describe, expect, it } from 'vitest'
import { splitMarkdownFrontmatter } from './markdown-frontmatter'

describe('Markdown frontmatter', () => {
  it('extracts generated metadata and returns only the article body', () => {
    const result = splitMarkdownFrontmatter(`---
title: "Example"
adapter: "x"
warnings: ["媒体未加载"]
---

# Example

Body`)

    expect(result.metadata).toEqual({ title: 'Example', adapter: 'x', warnings: ['媒体未加载'] })
    expect(result.body).toBe('\n# Example\n\nBody')
  })

  it('does not hide an opening thematic break without frontmatter fields', () => {
    const content = '---\n\n普通正文\n\n---'
    expect(splitMarkdownFrontmatter(content)).toEqual({ body: content, metadata: {} })
  })
})
