import { expect, test } from '@playwright/test'

const reconstruction = [
  'flowchart TD',
  'C["线性辐亮度与确定性体特征"] --> S["5×5 特征引导空间滤波"]',
  'S --> V{"预览且历史通过匹配"}',
  'V -->|是| H["亮度钳位与历史混合"]',
  'V -->|否| K["采用空间结果"]',
  'H --> U["边缘引导上采样"]',
  'K --> U',
  'U --> O["色调映射与窗口呈现"]',
  'U --> L["线性 HDR 捕获"]',
].join('\n')

const markdown = (...diagrams: string[]) => diagrams.map((source) => '~~~mermaid\n' + source + '\n~~~').join('\n\n')
const settingsKey = 'lightpage.settings.v1'

test('精致流程图保留全部节点和分支，并在窄屏及深浅主题下可读', async ({ page }, testInfo) => {
  await page.goto('/')
  for (const themeMode of ['light', 'dark']) {
    await page.evaluate(([key, theme]) => localStorage.setItem(key, JSON.stringify({ themeMode: theme })), [settingsKey, themeMode])
    await page.reload()
    await page.locator('input[type="file"]').setInputFiles({
      name: '中文流程图.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown(reconstruction)),
    })
    const figure = page.locator('.mermaid-diagram')
    const svg = figure.locator('svg').first()
    await expect(figure).toHaveAttribute('data-diagram-appearance', 'refined')
    await expect(svg.locator('g.node')).toHaveCount(8)
    await expect(svg.locator('.edgePaths path.flowchart-link')).toHaveCount(8)
    await expect(svg.locator('.edgeLabel').filter({ hasText: /^[是否]$/ })).toHaveCount(2)
    await expect(svg.locator('.lp-decision rect.label-container')).toHaveCount(1)
    await expect(page.locator('pre > figure.mermaid-diagram')).toHaveCount(0)
    await expect(svg.locator('foreignObject')).toHaveCount(0)

    const geometry = await svg.evaluate((root) => {
      const box = (root as unknown as SVGSVGElement).viewBox.baseVal
      const nodes = Array.from(root.querySelectorAll('.nodes .label-container'), (node) => node.getBoundingClientRect())
      const labels = Array.from(root.querySelectorAll('.edgeLabel text'), (label) => label.getBoundingClientRect())
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      return {
        height: box.height,
        labelOverlaps: labels.some((label) => nodes.some((node) => overlaps(label, node))),
        boundsFit: root.getBoundingClientRect().width <= root.parentElement!.clientWidth + 1,
        color: getComputedStyle(root.querySelector('.node rect.label-container')!).fill,
      }
    })
    expect(geometry.height).toBeLessThanOrEqual(700)
    expect(geometry.labelOverlaps).toBe(false)
    expect(geometry.boundsFit).toBe(true)
    expect(geometry.color).toBe(themeMode === 'light' ? 'rgb(227, 241, 252)' : 'rgb(32, 56, 78)')
    await testInfo.attach('figure-5-' + themeMode, { body: await figure.screenshot(), contentType: 'image/png' })
  }
})

test('设置中的原始模式可持久化，并保留作者样式、状态图和无效图源码', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  const style = page.getByRole('button', { name: /流程图样式/ })
  await expect(style).toContainText('精致')
  await style.click()
  await expect(style).toContainText('原始')
  await page.goto('/')
  const content = markdown(
    reconstruction,
    'flowchart LR\nsubgraph Group["说明"]\nA["输入 & 输出<br/>第二行"] --> B["结束"]\nend\nstyle A fill:#ffcccc',
    'stateDiagram-v2\n[*] --> Running\nRunning --> [*]',
    'not a diagram',
  )
  await page.locator('input[type="file"]').setInputFiles({
    name: '原始流程图.md', mimeType: 'text/markdown', buffer: Buffer.from(content),
  })
  const graphs = page.locator('.mermaid-diagram')
  await expect(graphs.nth(0)).toHaveAttribute('data-diagram-appearance', 'original')
  await expect(graphs.nth(0).locator('.lp-decision')).toHaveCount(0)
  await expect(graphs.nth(0).locator('g.node')).toHaveCount(8)
  await expect(graphs.nth(1)).toHaveAttribute('data-diagram-appearance', 'original')
  await expect(graphs.nth(1).locator('.node rect').first()).toHaveCSS('fill', 'rgb(255, 204, 204)')
  await expect(graphs.nth(2)).toHaveAttribute('data-diagram-appearance', 'original')
  await expect(graphs.nth(3).getByRole('alert')).toContainText('not a diagram')
})


test('富文本复制保留精致流程图图片', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: '复制流程图.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown(reconstruction)),
  })
  await expect(page.locator('.mermaid-diagram')).toHaveAttribute('data-diagram-appearance', 'refined')
  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('button', { name: '复制富文本' }).click()
  await expect(page.getByText('已复制富文本', { exact: true })).toBeVisible()
  const hasImage = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    const html = await (await item.getType('text/html')).text()
    const copied = new DOMParser().parseFromString(html, 'text/html')
    return Array.from(copied.images).some((image) => image.alt === 'Mermaid 流程图' && image.src.startsWith('data:image/png'))
  })
  expect(hasImage).toBe(true)
})
