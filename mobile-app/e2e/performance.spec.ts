import { expect, test } from '@playwright/test'

test('1 MB 文档打开与搜索保持在发布性能门槛内', async ({ page }) => {
  const ciWallClockMultiplier = process.env.CI ? 3 : 1
  await page.goto('/')
  const heading = '# 一兆文档\n\n'
  const seed = '性能基准正文，包含中文和普通段落。 '
  const targetBytes = 1024 * 1024
  const repeatCount = Math.ceil(targetBytes / Buffer.byteLength(seed))
  const content = `${heading}${seed.repeat(repeatCount)}\n\n唯一搜索词-Q7X9`

  const openStartedAt = Date.now()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'benchmark-1mb.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(content),
  })
  await expect(page.getByRole('heading', { name: '一兆文档', exact: true }).first()).toBeVisible({ timeout: 5_000 * ciWallClockMultiplier })
  expect(Date.now() - openStartedAt).toBeLessThan(2_500 * ciWallClockMultiplier)
  const openMetric = await page.evaluate(() => {
    const metrics = JSON.parse(localStorage.getItem('lightpage.performance.v1') ?? '[]') as Array<{ name: string; durationMs: number }>
    return metrics.reverse().find((metric) => metric.name === 'file-open')?.durationMs
  })
  expect(openMetric).toBeDefined()
  expect(openMetric as number).toBeLessThan(1000)

  await page.getByRole('button', { name: '搜索' }).click()
  const searchStartedAt = Date.now()
  await page.getByPlaceholder('搜索当前文档').fill('唯一搜索词-Q7X9')
  await expect(page.locator('.search-count')).toHaveText('1/1')
  expect(Date.now() - searchStartedAt).toBeLessThan(1_500 * ciWallClockMultiplier)
  const searchMetric = await page.evaluate(() => {
    const metrics = JSON.parse(localStorage.getItem('lightpage.performance.v1') ?? '[]') as Array<{ name: string; durationMs: number }>
    return metrics.reverse().find((metric) => metric.name === 'document-search' && metric.durationMs > 0)?.durationMs
  })
  expect(searchMetric).toBeDefined()
  expect(searchMetric as number).toBeLessThan(150)
})
