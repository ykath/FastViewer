import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '轻页' })).toBeVisible()
})

test('选择 Markdown 后进入阅读并可恢复到首页文件库', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({
    name: '回归测试.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 回归标题\n\n这是正文。'),
  })
  await expect(page.getByText('回归测试.md')).toBeVisible()
  await expect(page.getByRole('heading', { name: '回归标题' })).toBeVisible()
  await page.getByRole('button', { name: '首页' }).click()
  await expect(page.getByText('回归测试.md')).toBeVisible()
})

test('文内搜索可用回车切换到下一个结果', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({
    name: '搜索回车.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 搜索\n\n关键字 第一处\n\n关键字 第二处'),
  })
  await page.getByRole('button', { name: '搜索' }).click()
  const searchInput = page.getByPlaceholder('搜索当前文档')
  await searchInput.fill('关键字')
  await expect(page.locator('.search-count')).toHaveText('1/2')
  await searchInput.press('Enter')
  await expect(page.locator('.search-count')).toHaveText('2/2')
  await searchInput.press('Shift+Enter')
  await expect(page.locator('.search-count')).toHaveText('1/2')
})

test('粘贴 HTML 会显示安全预览并在严格沙盒打开', async ({ page }) => {
  await page.getByRole('button', { name: '粘贴打开' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill('<h1>安全预览</h1><script>document.body.dataset.bad="1"</script>')
  await expect(dialog.getByText(/检测为 HTML/)).toBeVisible()
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  const frame = page.frameLocator('iframe[title="HTML 阅读视图"]')
  await expect(frame.getByRole('heading', { name: '安全预览' })).toBeVisible()
  await expect(frame.locator('body')).not.toHaveAttribute('data-bad', '1')
})

test('手机端脚本隔离 HTML 会铺满到底部导航，不再保留遮挡空白', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({
    name: '隔离页面.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<!doctype html><h1>隔离页面</h1><script>document.body.dataset.ready="1"</script>'),
  })
  await page.evaluate(() => { document.documentElement.dataset.runtime = 'native' })
  await page.getByRole('button', { name: '打开 HTML 权限设置' }).click()
  const permissions = page.locator('.sheet').filter({ hasText: 'HTML 权限' })
  await permissions.getByRole('switch', { name: /运行脚本/ }).click()
  await permissions.getByRole('button', { name: '关闭' }).click()

  await expect.poll(async () => page.evaluate(() => {
    const frameBottom = document.querySelector('.html-frame')?.getBoundingClientRect().bottom ?? 0
    const navigationTop = document.querySelector('.bottom-nav')?.getBoundingClientRect().top ?? 0
    return Math.abs(frameBottom - navigationTop)
  })).toBeLessThanOrEqual(2)
})

test('设置页可切换系统主题和阅读排版', async ({ page }) => {
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  const themeButton = page.getByRole('button', { name: /阅读主题/ })
  await themeButton.scrollIntoViewIfNeeded()
  await themeButton.click()
  await expect(themeButton).toContainText('浅色')
  const lineHeightButton = page.getByRole('button', { name: /正文行高/ })
  await lineHeightButton.scrollIntoViewIfNeeded()
  await lineHeightButton.click()
  await expect(lineHeightButton).toContainText('宽松')
})

test('手机端仍使用底部导航和文件操作抽屉', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({
    name: '手机布局.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 手机阅读\n\n正文。'),
  })
  await expect(page.getByRole('heading', { name: '手机阅读' })).toBeVisible()
  await expect(page.locator('.desktop-toc')).toBeHidden()

  const navigationBox = await page.locator('.bottom-nav').boundingBox()
  expect(navigationBox).not.toBeNull()
  expect(navigationBox?.width).toBeGreaterThan(300)
  expect((navigationBox?.y ?? 0) + (navigationBox?.height ?? 0)).toBeGreaterThan(800)

  await page.getByRole('button', { name: '更多' }).click()
  await expect(page.locator('.mobile-file-menu .sheet')).toBeVisible()
  await expect(page.locator('.desktop-popover')).toBeHidden()
})
