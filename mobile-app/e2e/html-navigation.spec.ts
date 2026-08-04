import { expect, test } from '@playwright/test'

const interactiveHtml = `<!doctype html>
<html>
  <body>
    <a id="chapter-link" href="#chapter-2">Next chapter</a>
    <button id="action" type="button">Run action</button>
    <output id="result">not run</output>
    <div style="height: 1200px"></div>
    <h2 id="chapter-2">Chapter 2</h2>
    <div style="height: 1200px"></div>
    <script>
      document.querySelector('#action').addEventListener('click', () => {
        document.querySelector('#result').textContent = 'action complete'
      })
    </script>
  </body>
</html>`

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'interactive.html',
    mimeType: 'text/html',
    buffer: Buffer.from(interactiveHtml),
  })
})

test('strict sandbox keeps an internal navigation link in the current HTML document', async ({ page }) => {
  const frameElement = page.locator('iframe[title="HTML 阅读视图"]')
  const frame = page.frameLocator('iframe[title="HTML 阅读视图"]')

  await frame.locator('#chapter-link').click()

  await expect(frame.getByRole('heading', { name: 'Chapter 2' })).toBeVisible()
  await expect(frame.locator('body')).toContainText('Next chapter')
  await expect(frameElement).toHaveAttribute('srcdoc', /base href="about:srcdoc"/)
})

test('script sandbox preserves internal navigation and button interactions', async ({ page }) => {
  await page.getByRole('button', { name: '打开 HTML 权限设置' }).click()
  const permissions = page.locator('.sheet').filter({ hasText: 'HTML 权限' })
  await permissions.getByRole('switch', { name: /运行脚本/ }).click()
  await permissions.getByRole('button', { name: '关闭' }).click()

  const frame = page.frameLocator('iframe[title="HTML 阅读视图"]')
  await frame.locator('#chapter-link').click()
  await expect(frame.getByRole('heading', { name: 'Chapter 2' })).toBeVisible()
  await expect(frame.locator('body')).toContainText('Next chapter')

  await frame.locator('#action').click()
  await expect(frame.locator('#result')).toHaveText('action complete')
})

test('app table of contents scrolls an isolated script-enabled HTML document', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { document.documentElement.dataset.runtime = 'desktop' })
  await page.getByRole('button', { name: '打开 HTML 权限设置' }).click()
  const permissions = page.locator('.sheet').filter({ hasText: 'HTML 权限' })
  await permissions.getByRole('switch', { name: /运行脚本/ }).click()
  await permissions.getByRole('button', { name: '关闭' }).click()

  const frame = page.frameLocator('iframe[title="HTML 阅读视图"]')
  const chapter = frame.getByRole('heading', { name: 'Chapter 2' })
  await expect.poll(() => chapter.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThan(900)

  await page.locator('.desktop-toc').getByRole('button', { name: 'Chapter 2' }).click()

  await expect.poll(() => chapter.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(200)
})
