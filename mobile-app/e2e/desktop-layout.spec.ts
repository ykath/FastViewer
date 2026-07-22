import { expect, test } from '@playwright/test'

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
})

test('桌面端使用侧边导航、常驻章节栏和点击定位的文件菜单', async ({ page }) => {
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
  await expect(directory.getByRole('button', { name: '第一章' })).toBeVisible()
  const documentPaneBox = await page.locator('.reader-document-pane').boundingBox()
  expect(documentPaneBox).not.toBeNull()
  expect(documentPaneBox?.x).toBeGreaterThanOrEqual(384)
  expect(documentPaneBox?.width).toBeGreaterThan(900)

  await page.getByRole('button', { name: '章节', exact: true }).click()
  await expect(directory).toBeHidden()
  await page.getByRole('button', { name: '章节', exact: true }).click()
  await expect(directory).toBeVisible()

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
