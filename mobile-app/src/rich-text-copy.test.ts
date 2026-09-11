// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  buildRichTextPayload,
  waitForRichTextRender,
  writeRichTextToClipboard,
} from './rich-text-copy'

describe('Markdown 富文本复制', () => {
  it('生成适合邮件和 Word 的 HTML 与纯文本，并清理阅读器标记', async () => {
    const root = document.createElement('article')
    root.className = 'reader-content markdown-body'
    root.innerHTML = `
      <style data-search-exclude="true">.hidden{display:none}</style>
      <h1 id="title">报告标题</h1>
      <p>正文 <strong>加粗</strong> <mark class="search-hit">搜索词</mark></p>
      <ul><li class="task-list-item"><input type="checkbox" checked disabled>已完成</li></ul>
      <blockquote><p><mark class="annotation-highlight" data-annotation-id="a1">引用内容</mark></p></blockquote>
      <div class="markdown-table-wrap"><table><thead><tr><th>项目</th><th>状态</th></tr></thead><tbody><tr><td>复制</td><td>完成</td></tr></tbody></table></div>
      <pre><code class="language-ts"><span class="hljs-keyword">const</span> ok = true</code></pre>
      <p><a href="https://example.com" target="_blank">链接</a></p>
      <img src="data:image/png;base64,AAAA" alt="示意图" loading="lazy">
      <button type="button">不应复制</button>
    `

    const payload = await buildRichTextPayload(root, '测试报告.md')

    expect(payload.html).toContain('<title>测试报告.md</title>')
    expect(payload.html).toContain('<h1 style="font-size:28px;')
    expect(payload.html).toContain('<table style="width:100%;')
    expect(payload.html).toContain('href="https://example.com"')
    expect(payload.html).toContain('src="data:image/png;base64,AAAA"')
    expect(payload.html).toContain('☑ ')
    expect(payload.html).toContain('已完成')
    expect(payload.html).not.toMatch(/search-hit|annotation-highlight|data-annotation-id|markdown-table-wrap/)
    expect(payload.html).not.toContain('<button')
    expect(payload.html).not.toContain('<style')
    expect(payload.text).toContain('报告标题')
    expect(payload.text).toContain('搜索词')
    expect(payload.text).toContain('☑ 已完成')
    expect(payload.text).toContain('[图片：示意图]')
  })

  it('将 Mermaid 转为图片，编码失败时保留源码', async () => {
    const root = document.createElement('article')
    root.innerHTML = '<figure class="mermaid-diagram" data-mermaid-source="flowchart LR; A-->B"><div class="mermaid-svg"><svg viewBox="0 0 100 50"></svg></div></figure>'
    const renderMermaid = vi.fn().mockResolvedValue('data:image/png;base64,MERMAID')

    const payload = await buildRichTextPayload(root, '流程图.md', { renderMermaid })
    expect(renderMermaid).toHaveBeenCalledOnce()
    expect(payload.html).toContain('src="data:image/png;base64,MERMAID"')
    expect(payload.html).toContain('alt="Mermaid 流程图"')

    const fallback = await buildRichTextPayload(root, '流程图.md', {
      renderMermaid: vi.fn().mockRejectedValue(new Error('canvas unavailable')),
    })
    expect(fallback.html).toContain('flowchart LR; A--&gt;B')
    expect(fallback.html).not.toContain('<svg')
  })

  it('同时向现代剪贴板写入 text/html 和 text/plain', async () => {
    let written: ClipboardItem[] = []
    class FakeClipboardItem {
      readonly values: Record<string, Blob>

      constructor(values: Record<string, Blob>) {
        this.values = values
      }
    }
    await writeRichTextToClipboard(
      { html: '<strong>富文本</strong>', text: '富文本' },
      {
        clipboard: { write: vi.fn(async (items) => { written = items }) },
        ClipboardItemClass: FakeClipboardItem as unknown as typeof ClipboardItem,
      },
    )

    expect(written).toHaveLength(1)
    const values = (written[0] as unknown as FakeClipboardItem).values
    expect(await values['text/html'].text()).toBe('<strong>富文本</strong>')
    expect(await values['text/plain'].text()).toBe('富文本')
  })

  it('等待渐进区块和 Mermaid 全部就绪', async () => {
    const root = document.createElement('article')
    root.className = 'progressive-markdown'
    root.dataset.renderComplete = 'false'
    root.innerHTML = '<div data-render-block="one" data-rich-copy-ready="false"></div><figure class="mermaid-diagram" data-render-status="pending"></figure>'
    window.setTimeout(() => {
      root.dataset.renderComplete = 'true'
      root.querySelector<HTMLElement>('[data-render-block]')!.dataset.richCopyReady = 'true'
      root.querySelector<HTMLElement>('.mermaid-diagram')!.dataset.renderStatus = 'ready'
    }, 10)

    await expect(waitForRichTextRender(() => root, 500)).resolves.toBe(root)
  })
})
