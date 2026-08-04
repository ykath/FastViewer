import { expect, test } from '@playwright/test'

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
})

test('Windows URL 导入通过交互重试后加入文件库并立即打开', async ({ page }) => {
  await page.addInitScript(() => {
    let finishInteractive: (() => void) | undefined
    const markdown = new TextEncoder().encode('# 模拟网页标题\n\n这是由模拟 Tauri IPC 返回的网页正文。')
    const success = {
      status: 'ok',
      requestedUrl: 'https://example.com/article',
      canonicalUrl: 'https://example.com/article',
      adapter: 'generic',
      title: '模拟网页标题',
      outputPath: 'C:\\Users\\Tester\\Documents\\LightPage\\url-to-markdown\\example.com\\article\\article.md',
      downloadedImages: 0,
      warnings: [],
      openRequest: {
        path: 'C:\\Users\\Tester\\Documents\\LightPage\\url-to-markdown\\example.com\\article\\article.md',
        fileName: 'article.md',
        size: markdown.length,
        source: 'url',
      },
    }
    window.__LIGHTPAGE_DESKTOP_MOCK__ = {
      invoke: async (command, args) => {
        if (command === 'take_pending_open_requests') return [] as never
        if (command === 'import_url') {
          if (!args?.interactive) {
            return {
              status: 'needsInteraction',
              requestedUrl: success.requestedUrl,
              adapter: 'generic',
              interaction: { kind: 'login', provider: '示例站点', reason: '页面要求登录' },
            } as never
          }
          return new Promise((resolve) => {
            finishInteractive = () => resolve(success as never)
          })
        }
        if (command === 'resume_url_import') {
          finishInteractive?.()
          return undefined as never
        }
        if (command === 'resolve_relative_resources') return {} as never
        return undefined as never
      },
      listen: async () => () => undefined,
      readFile: async () => markdown,
      listenForDrops: async () => () => undefined,
    }
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: /打开 URL/ })).toBeVisible()
  await page.getByRole('button', { name: /打开 URL/ }).click()
  const dialog = page.getByRole('dialog', { name: '从 URL 导入' })
  await dialog.getByRole('textbox', { name: '网页地址' }).fill('https://example.com/article')
  await dialog.getByRole('button', { name: '开始导入' }).click()
  await expect(dialog.getByText(/示例站点：页面要求登录/)).toBeVisible()

  await dialog.getByRole('button', { name: '打开浏览器重试' }).click()
  await expect(dialog.getByRole('button', { name: '我已完成，继续' })).toBeVisible()
  await dialog.getByRole('button', { name: '我已完成，继续' }).click()

  await expect(page.getByRole('heading', { name: '模拟网页标题', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '首页' }).click()
  await expect(page.getByText('article.md')).toBeVisible()
  await expect(page.getByText('example.com', { exact: true })).toBeVisible()
  await expect(page.getByText(/URL 导入/)).toBeVisible()
})
