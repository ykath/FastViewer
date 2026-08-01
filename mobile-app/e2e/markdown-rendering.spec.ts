import { expect, test } from '@playwright/test'

test('Markdown 可绘制多行 Python、Mermaid 流程图和数学公式', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: '渲染能力.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# Markdown 渲染

\`\`\`python
def hello():
    print("hello")

hello()
\`\`\`

行内公式 $x^2$。

$$\\text{CNR} = \\frac{HU_{\\text{target}} - HU_{\\text{background}}}{\\sigma_{\\text{background}}}$$

\`\`\`mermaid
flowchart TD
  A[开始] --> B[结束]
\`\`\`
`),
  })

  await expect(page.locator('code.language-python')).toContainText('def hello():\n    print("hello")\n\nhello()')
  await expect(page.locator('.katex-display .katex')).toBeVisible()
  await expect(page.locator('.mermaid-svg svg')).toBeVisible()

  await page.getByRole('button', { name: '搜索' }).click()
  await page.locator('.search-panel input').fill('开始')
  await expect(page.locator('.search-count')).toHaveText('0/0')
  await expect(page.locator('.mermaid-diagram mark.search-hit')).toHaveCount(0)
})

test('横向 Mermaid 流程图会缩放到正文宽度且不产生水平滚动条', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: '宽流程图.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`\`\`\`mermaid
flowchart LR
  A["Windows WebView2"] --> B["React 19 UI<br/>App.tsx + App.css"]
  B --> C["前端后端适配层<br/>services/backend.ts"]
  C -->|"invoke / Channel"| D["Tauri IPC 命令层<br/>commands.rs"]
  D --> E["领域与编排<br/>models.rs / storage.rs / mineru.rs"]
  E --> F["工作区文件<br/>JSON / JSONL / Markdown / PDF / TXT"]
  E --> G["Windows 凭据管理器<br/>API Key / Token"]
\`\`\``),
  })

  const diagram = page.locator('.mermaid-diagram')
  const svg = diagram.locator('svg')
  await expect(svg).toBeVisible({ timeout: 30_000 })

  const dimensions = await diagram.evaluate((element) => {
    const renderedSvg = element.querySelector('svg')
    if (!renderedSvg) throw new Error('Mermaid 图表尚未准备完成')
    return {
      diagramClientWidth: element.clientWidth,
      diagramScrollWidth: element.scrollWidth,
      svgWidth: renderedSvg.getBoundingClientRect().width,
    }
  })

  expect(dimensions.diagramScrollWidth).toBeLessThanOrEqual(dimensions.diagramClientWidth + 1)
  expect(dimensions.svgWidth).toBeLessThanOrEqual(dimensions.diagramClientWidth + 1)
})

test('Windows 可双击 Mermaid 并缩放、拖动和复位大图', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: '复杂流程图.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`\`\`\`mermaid
flowchart LR
  A01[需求输入] --> A02[范围分析] --> A03[架构设计] --> A04[接口设计] --> A05[桌面开发] --> A06[资源处理] --> A07[集成测试] --> A08[性能测试] --> A09[安装验证] --> A10[灰度发布] --> A11[稳定发布]
  A03 --> B01[复杂横向分支] --> B02[文档身份] --> B03[目录枚举] --> B04[文件监听] --> B05[索引更新] --> A07
\`\`\``),
  })
  await page.evaluate(() => { document.documentElement.dataset.runtime = 'desktop' })
  const diagram = page.locator('.mermaid-svg')
  await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 })
  await diagram.dblclick()

  const viewer = page.getByRole('dialog', { name: 'Mermaid 大图查看器' })
  await expect(viewer).toBeVisible()
  const zoomImage = viewer.getByRole('img', { name: '放大的 Mermaid 流程图' })
  await expect(zoomImage).toBeVisible()
  const zoomSvg = zoomImage.locator('svg')
  await expect(zoomSvg).toBeVisible()
  const imageDimensions = await zoomSvg.evaluate((image) => ({
    clientWidth: image.getBoundingClientRect().width,
    clientHeight: image.getBoundingClientRect().height,
  }))
  expect(imageDimensions.clientWidth).toBeGreaterThan(0)
  expect(imageDimensions.clientHeight).toBeGreaterThan(0)
  await expect(viewer.getByLabel('当前缩放比例')).toHaveText('100%')
  await viewer.getByRole('button', { name: '放大流程图' }).click()
  await expect(viewer.getByLabel('当前缩放比例')).toHaveText('125%')

  const canvas = viewer.locator('.mermaid-zoom-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('缺少流程图画布')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 45)
  await page.mouse.up()
  await expect(viewer.locator('.mermaid-zoom-image')).toHaveAttribute('style', /translate\(80px, 45px\) scale\(1\.25\)/)

  await viewer.getByRole('button', { name: '适应窗口' }).press('Enter')
  await expect(viewer.getByLabel('当前缩放比例')).toHaveText('100%')
  await expect(viewer.locator('.mermaid-zoom-image')).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/)
  await canvas.dispatchEvent('wheel', { deltaY: -200 })
  await expect(viewer.getByLabel('当前缩放比例')).toHaveText('135%')
  await viewer.getByRole('button', { name: '适应窗口' }).press('Enter')

  const duplicateIds = await page.evaluate(() => {
    const original = new Set(Array.from(document.querySelectorAll('.mermaid-diagram svg[id], .mermaid-diagram svg [id]'), (element) => element.id))
    return Array.from(document.querySelectorAll('.mermaid-zoom-image svg[id], .mermaid-zoom-image svg [id]')).filter((element) => original.has(element.id)).length
  })
  expect(duplicateIds).toBe(0)

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('滚动长文档时 Mermaid 图表不会重复绘制或改变页面高度', async ({ page }) => {
  await page.goto('/')
  const fixturePath = process.env.MARKDOWN_FLICKER_FIXTURE
  if (fixturePath) {
    await page.locator('input[type="file"]').setInputFiles(fixturePath)
  } else {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'Mermaid 滚动回归.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(createLongMermaidDocument()),
    })
  }

  const diagrams = page.locator('.mermaid-diagram')
  await expect(diagrams.first()).toBeVisible({ timeout: 30_000 })
  await expect(diagrams.first().locator('.mermaid-svg svg')).toBeVisible({ timeout: 30_000 })
  const diagramCount = await diagrams.count()
  expect(diagramCount).toBeGreaterThan(1)
  const initiallyRendered = await page.locator('.mermaid-svg svg').count()
  expect(initiallyRendered).toBeLessThan(diagramCount)

  await page.evaluate(() => {
    const content = document.querySelector('.mermaid-diagram')
    const firstSvg = document.querySelector('.mermaid-svg svg')
    if (!content || !firstSvg) throw new Error('Mermaid 图表尚未准备完成')
    const state = window as typeof window & {
      mermaidRegression?: { firstSvg: Element; mutations: number; observer: MutationObserver }
    }
    const regression = {
      firstSvg,
      mutations: 0,
      observer: new MutationObserver((records) => {
        regression.mutations += records.reduce((count, record) => count + record.addedNodes.length + record.removedNodes.length, 0)
      }),
    }
    regression.observer.observe(content, { childList: true, subtree: true })
    state.mermaidRegression = regression
  })

  const reader = page.locator('.page-reader')
  for (const progress of [0.15, 0.35, 0.6, 0.85, 0.4, 0.75]) {
    await reader.evaluate((element, ratio) => {
      element.scrollTo({ top: (element.scrollHeight - element.clientHeight) * ratio })
    }, progress)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(1_200)

  const result = await page.evaluate(() => {
    const state = (window as typeof window & {
      mermaidRegression?: { firstSvg: Element; mutations: number; observer: MutationObserver }
    }).mermaidRegression
    if (!state) throw new Error('缺少 Mermaid 回归监视器')
    state.observer.disconnect()
    return {
      mutations: state.mutations,
      sameSvg: state.firstSvg === document.querySelector('.mermaid-svg svg'),
    }
  })

  expect(result).toEqual({ mutations: 0, sameSvg: true })
})

function createLongMermaidDocument() {
  const sections = Array.from({ length: 40 }, (_, index) => `## 章节 ${index + 1}\n\n${'用于滚动测试的正文。'.repeat(20)}`).join('\n\n')
  return `# Mermaid 长文档

\`\`\`mermaid
flowchart TB
  A[开始] --> B[处理] --> C[结束]
\`\`\`

${sections}

\`\`\`mermaid
sequenceDiagram
  participant A as 调用方
  participant B as 服务
  A->>B: 请求
  B-->>A: 响应
\`\`\`

${sections}

\`\`\`mermaid
stateDiagram-v2
  [*] --> Ready
  Ready --> Working
  Working --> Ready
\`\`\`
`
}
