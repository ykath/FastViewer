import { expect, test } from '@playwright/test'

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
})

test('桌面端使用单文件阅读、章节/当前目录导航和点击定位的文件菜单', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '轻页' })).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({
    name: '桌面布局.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 总览\n\n## 第一章\n\n正文\n\n## 第二章\n\n更多正文。'),
  })
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset.runtime = 'desktop'
  })
  await expect.poll(() => page.locator('.reader-document-pane').evaluate((element) => getComputedStyle(element).marginLeft)).toBe('292px')

  const navigationBox = await page.locator('.bottom-nav').boundingBox()
  expect(navigationBox).not.toBeNull()
  expect(navigationBox?.x).toBe(0)
  expect(navigationBox?.width).toBe(92)
  expect(navigationBox?.height).toBe(900)

  const directory = page.locator('.desktop-toc')
  await expect(directory).toBeVisible()
  const chapterTab = directory.getByRole('tab', { name: '章节' })
  const currentDirectoryTab = directory.getByRole('tab', { name: '当前目录' })
  await expect(chapterTab).toHaveAttribute('aria-selected', 'true')
  const chapterTabBox = await chapterTab.boundingBox()
  const currentDirectoryTabBox = await currentDirectoryTab.boundingBox()
  expect(Math.abs((chapterTabBox?.y ?? 0) - (currentDirectoryTabBox?.y ?? 0))).toBeLessThanOrEqual(1)
  expect(currentDirectoryTabBox?.x ?? 0).toBeGreaterThan(chapterTabBox?.x ?? 0)
  await expect(directory.getByRole('button', { name: '第一章' })).toBeVisible()
  const documentPaneBox = await page.locator('.reader-document-pane').boundingBox()
  expect(documentPaneBox).not.toBeNull()
  expect(documentPaneBox?.x).toBeGreaterThanOrEqual(384)
  expect(documentPaneBox?.width).toBeGreaterThan(900)

  await currentDirectoryTab.click()
  await expect(directory.getByText('当前文件没有可访问的本地目录。')).toBeVisible()
  await chapterTab.click()
  await expect(directory.getByRole('button', { name: '第一章' })).toBeVisible()

  await page.getByRole('button', { name: '目录', exact: true }).click()
  await expect(directory).toBeHidden()
  await page.getByRole('button', { name: '目录', exact: true }).click()
  await expect(directory).toBeVisible()
  await expect(page.locator('.desktop-tab-bar')).toHaveCount(0)

  const fileMenuButton = page.getByRole('button', { name: '文件操作', exact: true })
  const fileMenuButtonBox = await fileMenuButton.boundingBox()
  await fileMenuButton.click()
  const popover = page.locator('.desktop-popover')
  await expect(popover).toBeVisible()
  const popoverBox = await popover.boundingBox()
  expect(popoverBox).not.toBeNull()
  expect(popoverBox?.y).toBeGreaterThan(fileMenuButtonBox?.y ?? 0)
  expect(popoverBox?.y).toBeLessThan(100)
  await expect(page.locator('.mobile-file-menu .sheet')).toBeHidden()
})

test('desktop reader keeps the Markdown header translucent and short HTML fills the viewport', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'translucent.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Header check\n\nBody'),
  })
  await page.evaluate(() => {
    document.documentElement.dataset.runtime = 'desktop'
  })

  const headerStyle = await page.locator('.reader-header').evaluate((element) => {
    const style = getComputedStyle(element)
    return { backgroundColor: style.backgroundColor, backdropFilter: style.backdropFilter }
  })
  expect(headerStyle.backdropFilter).toContain('blur')
  expect(headerStyle.backgroundColor).toMatch(/(?:rgba\([^)]*,\s*0\.\d+\)|\/\s*0\.\d+)/)

  await page.locator('input[type="file"]').setInputFiles({
    name: 'short.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<!doctype html><html><body><h1>Short HTML</h1><p>Only one line.</p></body></html>'),
  })
  await expect(page.frameLocator('.html-frame').getByRole('heading', { name: 'Short HTML' })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))

  await expect.poll(async () => {
    const frame = await page.locator('.html-frame').boundingBox()
    return frame ? Math.round(frame.y + frame.height) : 0
  }).toBeGreaterThanOrEqual(899)
})
