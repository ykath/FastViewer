import { expect, test, type Page } from '@playwright/test'

const filler = Array.from({ length: 30 }, (_, index) => `填充段落 ${index} ${'正文'.repeat(24)}`).join('\n\n')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLMediaElement && type === 'error') return undefined
      return original.call(this, type, listener, options)
    }
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '轻页' })).toBeVisible()
})

async function openMarkdown(page: Page, name: string, markdown: string) {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(markdown),
  })
  await expect(page.getByRole('heading', { name: name, level: 1 })).toBeVisible()
}

async function openMobileToc(page: Page) {
  await page.locator('.reader-actions').getByRole('button', { name: '目录', exact: true }).click()
  await expect(page.locator('.mobile-directory-sheet .sheet')).toBeVisible()
}

test('目录跳转在阅读器重绘后仍定位到原来的标题', async ({ page }) => {
  await openMarkdown(page, '目录锚点.md', [
    '# 开头',
    filler,
    '## 重复标题',
    '第一处重复标题下的正文。',
    filler,
    '## 重复标题',
    '第二处重复标题下的正文。',
  ].join('\n\n'))

  await expect(page.locator('.markdown-body h1')).toBeVisible()
  await openMobileToc(page)
  await page.locator('.mobile-directory-sheet [data-heading-id="重复标题-1"]').click()
  const secondHeading = page.locator('h2[id="重复标题-1"]')
  await expect(secondHeading).toBeInViewport()
  await expect(page.locator('[id="重复标题-2"]')).toHaveCount(0)

  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('button', { name: '查看源码' }).click()
  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('button', { name: '查看阅读视图' }).click()
  await expect(secondHeading).toHaveCount(1)
  await expect(page.locator('[id="重复标题-2"]')).toHaveCount(0)

  await openMobileToc(page)
  await page.locator('.mobile-directory-sheet [data-heading-id="重复标题-1"]').click()
  await expect(secondHeading).toBeInViewport()
})

test('滚动保存阅读位置时视频元素不被替换', async ({ page }) => {
  await openMarkdown(page, '视频稳定.md', [
    '# 视频',
    '开头正文。',
    '![片段](https://example.com/clip.mp4)',
    filler,
    '## 末尾',
    '末尾正文。',
  ].join('\n\n'))

  const video = page.locator('video.markdown-video')
  await expect(video).toBeVisible()
  await video.evaluate((element) => { element.dataset.stable = 'kept' })
  await page.locator('.page-reader').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(900)
  await expect(page.locator('video.markdown-video[data-stable="kept"]')).toHaveCount(1)
  await expect(page.locator('video.markdown-video source')).toHaveAttribute('src', 'https://example.com/clip.mp4')
})

test('相对文档链接可回到本文章节，缺失文档给出提示', async ({ page }) => {
  await openMarkdown(page, '回归链接.md', [
    '# 第一章',
    '见 [回到第一章](回归链接.md#第一章) 与 [缺失文档](缺失文档.md)。',
    filler,
    '# 第二章',
    '远处正文。',
  ].join('\n\n'))

  await page.locator('.page-reader').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.getByRole('link', { name: '回到第一章' }).click()
  await expect(page.locator('[id="第一章"]')).toBeInViewport()
  await expect(page.getByRole('heading', { name: '回归链接.md', level: 1 })).toBeVisible()

  await page.getByRole('link', { name: '缺失文档' }).click()
  await expect(page.getByRole('status')).toContainText('无法打开该文档链接')
})

test('离开后再打开会恢复上次章节位置', async ({ page }) => {
  await openMarkdown(page, '位置恢复.md', [
    '# 开头',
    filler,
    '# 末章',
    '末章正文，用来确认恢复位置。',
  ].join('\n\n'))

  await expect(page.locator('.markdown-body')).toBeVisible()
  await openMobileToc(page)
  await page.locator('.mobile-directory-sheet [data-heading-id="末章"]').click()
  await expect(page.locator('[id="末章"]')).toBeInViewport()

  await page.getByRole('button', { name: '返回' }).click()
  await page.locator('.file-open-button', { hasText: '位置恢复.md' }).click()
  await expect(page.locator('[id="末章"]')).toBeInViewport()
})

test('章节书签可以创建并跳转', async ({ page }) => {
  await openMarkdown(page, '批注跳转.md', [
    '# 开头',
    '这是可高亮的句子。',
    filler,
    '# 末章',
    '书签落在这一章。',
  ].join('\n\n'))

  await expect(page.locator('.markdown-body')).toBeVisible()
  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('button', { name: '添加章节书签' }).click()

  await openMobileToc(page)
  await page.locator('.mobile-directory-sheet [data-heading-id="末章"]').click()
  await expect(page.locator('[id="末章"]')).toBeInViewport()
  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('button', { name: /批注与书签/ }).click()
  const bookmark = page.locator('.annotation-item').filter({ hasText: '书签' }).locator('.annotation-main')
  await expect(bookmark).toHaveAttribute('data-heading-id', '开头')
  await bookmark.click()
  await expect(page.locator('[id="开头"]')).toBeInViewport()
})

test('首页全文搜索能打开文档并定位命中', async ({ page }) => {
  await openMarkdown(page, '检索样本.md', '# 检索标题\n\n这里有检索口令甲。\n')
  await page.getByRole('button', { name: '返回' }).click()
  await expect(page.getByRole('heading', { name: '轻页' })).toBeVisible()
  await page.getByLabel('搜索文件名或正文').fill('检索口令甲')
  const hit = page.locator('.search-hit', { hasText: '检索样本.md' })
  await expect(hit).toBeVisible()
  await hit.click()
  await expect(page.getByPlaceholder('搜索当前文档')).toHaveValue('检索口令甲')
})

test('RAR 文件提示转换为 ZIP', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.rar',
    mimeType: 'application/vnd.rar',
    buffer: Buffer.from('rar'),
  })
  await expect(page.getByText('请转换为 ZIP')).toBeVisible()
})
