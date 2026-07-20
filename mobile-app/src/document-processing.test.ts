// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildSafeHtmlDocument, extractMarkdownHeadings, rewriteRelativeResources } from './html-processing'

describe('HTML 安全处理', () => {
  it('严格模式阻止脚本、表单、弹窗载体和远程资源', () => {
    const result = buildSafeHtmlDocument(
      '<meta http-equiv="refresh" content="0"><script>alert(1)</script><form action="https://evil.test"><input></form><iframe src="https://evil.test"></iframe><img src="https://img.test/a.png">',
      { allowExternalResources: false, allowScripts: false, allowForms: false },
    )
    expect(result.srcDoc).not.toContain('alert(1)')
    expect(result.srcDoc).not.toContain('<form')
    expect(result.srcDoc).not.toContain('<iframe')
    expect(result.srcDoc).toContain('data-blocked-src="https://img.test/a.png"')
    expect(result.externalResources.map((item) => item.url)).toContain('https://img.test/a.png')
  })

  it('外部链接始终改写为 App 确认通道', () => {
    const result = buildSafeHtmlDocument('<a href="https://example.com">打开</a>', {
      allowExternalResources: true,
      allowScripts: true,
      allowForms: true,
    })
    expect(result.srcDoc).toContain('data-external-href="https://example.com"')
    expect(result.srcDoc).toContain('lightpage-external-link')
  })

  it('不会把 App 私有资源地址误判成远程联网资源', () => {
    const result = buildSafeHtmlDocument('<img src="http://localhost/_capacitor_file_/private/a.png">', {
      allowExternalResources: false,
      allowScripts: false,
      allowForms: false,
    })
    expect(result.srcDoc).toContain('src="http://localhost/_capacitor_file_/private/a.png"')
    expect(result.externalResources).toHaveLength(0)
  })

  it('脚本模式仍通过 CSP 和 App 桥接控制联网与弹窗', () => {
    const blocked = buildSafeHtmlDocument('<script>window.open("https://evil.test")</script>', {
      allowExternalResources: false,
      allowScripts: true,
      allowForms: false,
      allowPopups: false,
    })
    expect(blocked.srcDoc).toContain("connect-src 'none'")
    expect(blocked.srcDoc).toContain('window.open=function(){return null;}')

    const mediated = buildSafeHtmlDocument('<script>window.open("https://example.com")</script>', {
      allowExternalResources: false,
      allowScripts: true,
      allowForms: false,
      allowPopups: true,
    })
    expect(mediated.srcDoc).toContain('window.open=request')
    expect(mediated.srcDoc).toContain('lightpage-external-link')
  })
})

describe('目录和归档资源', () => {
  it('生成稳定且去重的 Markdown 标题锚点', () => {
    expect(extractMarkdownHeadings('# 标题\n## 标题')).toEqual([
      { id: '标题', level: 1, text: '标题' },
      { id: '标题-1', level: 2, text: '标题' },
    ])
  })

  it('只改写归档内已授权的相对资源', () => {
    const resources = { 'docs/images/a.png': 'app://safe/a.png' }
    const rewritten = rewriteRelativeResources(
      '<img src="images/a.png"><img src="../../secret.png">',
      'docs/readme.html',
      'docs/readme.html',
      resources,
    )
    expect(rewritten).toContain('src="app://safe/a.png"')
    expect(rewritten).toContain('src="../../secret.png"')
  })
})
