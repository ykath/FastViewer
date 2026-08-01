import { describe, expect, it } from 'vitest'
import { createRenderPlan } from './render-plan'

describe('Markdown RenderPlan', () => {
  it('不会从中间切断代码块、列表或表格节点', () => {
    const large = '正文'.repeat(40_000)
    const content = `# 开始\n\n${large}\n\n- 第一项\n- 第二项\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst value = 1\n\`\`\`\n\n## 结束`
    const plan = createRenderPlan(content)
    expect(plan.blocks.length).toBeGreaterThan(1)
    expect(plan.blocks.some((block) => block.source.includes('```ts') && block.source.includes('```\n'))).toBe(true)
    expect(plan.headings.map((item) => item.id)).toEqual(['开始', '结束'])
  })

  it('为重复标题生成全局稳定 ID', () => {
    const plan = createRenderPlan(`# 重复\n\n${'a'.repeat(70_000)}\n\n# 重复`)
    expect(plan.headings.map((item) => item.id)).toEqual(['重复', '重复-1'])
  })
})
