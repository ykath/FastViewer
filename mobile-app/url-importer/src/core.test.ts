import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapterForUrl, articleOutputPath, assessQuality, formatTimestamp, normalizeImportUrl, renderMarkdownDocument, safeWindowsSlug } from './core'

describe('URL importer core', () => {
  test('accepts only HTTP URLs', () => {
    expect(normalizeImportUrl(' https://example.com/a#part ').toString()).toBe('https://example.com/a')
    expect(() => normalizeImportUrl('file:///c:/secret')).toThrow()
  })

  test('selects site adapters', () => {
    expect(adapterForUrl(new URL('https://x.com/a/status/1'))).toBe('x')
    expect(adapterForUrl(new URL('https://youtu.be/abc'))).toBe('youtube')
    expect(adapterForUrl(new URL('https://news.ycombinator.com/item?id=1'))).toBe('hn')
    expect(adapterForUrl(new URL('https://example.com'))).toBe('generic')
  })

  test('creates Windows-safe Unicode slugs', () => {
    expect(safeWindowsSlug('  中文：测试 / 页面  ')).toBe('中文-测试-页面')
    expect(safeWindowsSlug('CON')).toBe('_CON')
  })

  test('uses a timestamp when an article directory already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'lightpage-url-output-'))
    try {
      const first = articleOutputPath(root, new URL('https://example.com/a'), 'My Article', new Date('2026-08-04T12:34:56Z'))
      mkdirSync(first.directory, { recursive: true })
      const second = articleOutputPath(root, new URL('https://example.com/a'), 'My Article', new Date('2026-08-04T12:34:56Z'))
      mkdirSync(second.directory, { recursive: true })
      const third = articleOutputPath(root, new URL('https://example.com/a'), 'My Article', new Date('2026-08-04T12:34:56Z'))
      expect(first.slug).toBe('My-Article')
      expect(second.slug).toBe('My-Article-20260804-123456')
      expect(third.slug).toBe('My-Article-20260804-123456-2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('renders source metadata and checks quality', () => {
    const markdown = renderMarkdownDocument({
      title: 'Example', requestedUrl: 'https://example.com/a', adapter: 'generic', warnings: ['X 提取已回退'], markdown: 'Long useful paragraph. '.repeat(12),
    })
    expect(markdown).toContain('requestedUrl: "https://example.com/a"')
    expect(markdown).toContain('warnings: ["X 提取已回退"]')
    expect(assessQuality(markdown, 'Example', 'generic').acceptable).toBe(true)
    expect(assessQuality('Please sign in to continue', 'Login', 'generic').acceptable).toBe(false)
    expect(assessQuality(`# Unrelated\n\n${'useful article '.repeat(20)}`, 'Expected title', 'generic').reason).toContain('标题')
    expect(assessQuality(Array.from({ length: 10 }, (_, index) => `[navigation-${index}](https://example.com/${index})`).join('\n'), 'Navigation', 'generic').reason).toContain('导航')
  })

  test('formats transcript timestamps', () => {
    expect(formatTimestamp(65.9)).toBe('01:05')
    expect(formatTimestamp(3661)).toBe('01:01:01')
  })
})
