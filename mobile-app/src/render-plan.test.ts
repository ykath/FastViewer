import { describe, expect, it } from 'vitest'
import { createRenderPlan, reconcileRenderPlans } from './render-plan'

describe('Markdown RenderPlan', () => {
  it('不会从中间切断代码块、列表或表格节点', () => {
    const large = '正文'.repeat(40_000)
    const content = `# 开始\n\n${large}\n\n- 第一项\n- 第二项\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst value = 1\n\`\`\`\n\n## 结束`
    const plan = createRenderPlan(content)
    expect(plan.blocks.length).toBeGreaterThan(1)
    expect(plan.blocks.some((block) => block.source.includes('```ts') && block.source.includes('```\n'))).toBe(true)
    expect(plan.headings.map((item) => item.id)).toEqual(['开始', '结束'])
    expect(plan.blocks.map((block) => block.source).join('')).toBe(content)
  })

  it('分块后逐字节保留空行、CRLF 和 Mermaid 围栏', () => {
    const content = `# 标题\r\n\r\n${'正文内容。'.repeat(20_000)}\r\n\r\n\`\`\`mermaid\r\nflowchart TD\r\n  A[开始] --> B[结束]\r\n\`\`\`\r\n\r\n结尾\r\n`
    const plan = createRenderPlan(content)
    expect(plan.blocks.map((block) => block.source).join('')).toBe(content)
    expect(plan.blocks.filter((block) => block.source.includes('```mermaid'))).toHaveLength(1)
    expect(plan.blocks.some((block) => block.source.includes('A[开始] --> B[结束]\r\n```'))).toBe(true)
  })

  it('为重复标题生成全局稳定 ID', () => {
    const plan = createRenderPlan(`# 重复\n\n${'a'.repeat(70_000)}\n\n# 重复`)
    expect(plan.headings.map((item) => item.id)).toEqual(['重复', '重复-1'])
  })
})

describe('大文档稳定分块', () => {
  it('不会把较短的反引号序列误判为长围栏的结束', () => {
    const padding = '前置正文。'.repeat(220_000)
    const fenced = '````markdown\n```\n# 这是代码内容，不是标题\n```\n````'
    const content = `# 开始\n\n${padding}\n\n${fenced}\n\n# 结束\n`
    const plan = createRenderPlan(content)
    expect(plan.blocks.map((block) => block.source).join('')).toBe(content)
    expect(plan.blocks.filter((block) => block.source.includes(fenced))).toHaveLength(1)
    expect(plan.headings.map((heading) => heading.text)).toEqual(['开始', '结束'])
  })

  it('章节局部变化时复用其他章节的稳定块 ID', () => {
    const padding = '正文。'.repeat(400_000)
    const first = createRenderPlan(`# 第一章\n\n${padding}\n\n# 第二章\n\n保持不变`)
    const second = createRenderPlan(`# 第一章\n\n${padding}新增\n\n# 第二章\n\n保持不变`)
    const reconciled = reconcileRenderPlans(first, second)
    const oldBlock = first.blocks.find((block) => block.headingIds.includes('第二章'))
    const newBlock = reconciled.blocks.find((block) => block.headingIds.includes('第二章'))
    expect(newBlock?.id).toBe(oldBlock?.id)
    expect(newBlock?.revision).toBe(oldBlock?.revision)
  })
})
