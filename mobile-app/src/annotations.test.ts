import { describe, expect, it } from 'vitest'
import { annotationsToMarkdown, reanchorAnnotation } from './annotations'
import type { DocumentAnnotation } from './domain-models'

const annotation: DocumentAnnotation = {
  id: 'a1',
  documentId: 'd1',
  kind: 'note',
  color: 'yellow',
  note: '重要结论',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  anchor: { revision: 'old', start: 2, end: 6, exact: '目标文本', prefix: '前文', suffix: '后文', headingId: '结论' },
}

describe('Markdown 批注锚点', () => {
  it('文档变化后按上下文重新定位', () => {
    const updated = reanchorAnnotation(annotation, '新增前文目标文本后文结束', 'new')
    expect(updated.status).toBe('active')
    expect(updated.anchor.start).toBe(4)
    expect(updated.anchor.revision).toBe('new')
  })

  it('无法匹配时保留为待重新关联', () => {
    expect(reanchorAnnotation(annotation, '内容已经完全改变', 'new').status).toBe('orphaned')
  })

  it('导出包含原文、批注和失效状态', () => {
    const markdown = annotationsToMarkdown('示例.md', [{ ...annotation, status: 'orphaned' }])
    expect(markdown).toContain('待重新关联')
    expect(markdown).toContain('目标文本')
    expect(markdown).toContain('重要结论')
  })
})
