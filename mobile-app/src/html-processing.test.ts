// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  buildSafeHtmlDocument,
  classifyMarkdownLink,
  getDocumentLinkBasePath,
  isSameDocumentPath,
  resolveDesktopDocumentPath,
  resolveDocumentLinkHref,
} from './html-processing'

describe('markdown document links', () => {
  it('classifies external, fragment, and document links', () => {
    expect(classifyMarkdownLink('https://example.com')).toBe('external')
    expect(classifyMarkdownLink('#chapter-2')).toBe('fragment')
    expect(classifyMarkdownLink('./guide.md')).toBe('document')
    expect(classifyMarkdownLink('javascript:alert(1)')).toBe('other')
  })

  it('resolves relative markdown paths with anchors', () => {
    expect(resolveDocumentLinkHref('../readme.md#intro', 'docs/chapter.md', true)).toEqual({
      path: 'readme.md',
      hash: 'intro',
    })
    expect(resolveDocumentLinkHref('%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md', '使用说明.md', false)).toEqual({
      path: '使用说明.md',
      hash: '',
    })
  })

  it('rejects package links that escape the archive root', () => {
    expect(resolveDocumentLinkHref('../../secret.md', 'docs/chapter.md', true)).toBeNull()
  })

  it('resolves desktop absolute paths from source files', () => {
    expect(resolveDesktopDocumentPath('C:\\Docs\\Guide\\readme.md', '../other.md')).toEqual({
      path: 'C:\\Docs\\other.md',
      hash: '',
    })
    expect(resolveDesktopDocumentPath('C:\\Docs\\Guide\\readme.md', './other.md')).toEqual({
      path: 'C:\\Docs\\Guide\\other.md',
      hash: '',
    })
    expect(resolveDesktopDocumentPath('C:\\Docs\\Guide\\nested\\readme.md', '../../other.md')).toEqual({
      path: 'C:\\Docs\\other.md',
      hash: '',
    })
  })

  it('prefers archive relative path when resolving package links', () => {
    expect(getDocumentLinkBasePath({
      sourceUri: 'D:\\archives\\notes.zip',
      fileName: 'level2.md',
      archiveRelativePath: 'docs/nested/level2.md',
      packageId: 'pkg',
    })).toBe('docs/nested/level2.md')
    expect(resolveDocumentLinkHref('../level1.md', 'docs/nested/level2.md', true)).toEqual({
      path: 'docs/level1.md',
      hash: '',
    })
  })

  it('compares document paths case-insensitively', () => {
    expect(isSameDocumentPath('Docs/Guide.md', 'docs/guide.md')).toBe(true)
  })
})

describe('buildSafeHtmlDocument', () => {
  it('keeps same-document fragment links inside the srcdoc document', () => {
    const result = buildSafeHtmlDocument(
      '<!doctype html><a href="#chapter-2">Next</a><h2 id="chapter-2">Chapter 2</h2>',
      { allowExternalResources: false, allowScripts: false, allowForms: false },
    )

    expect(result.srcDoc).toContain('<base href="about:srcdoc" target="_self" />')
    expect(result.srcDoc).toContain('base-uri about:')
    expect(result.srcDoc).toContain('<a href="#chapter-2">Next</a>')
  })

  it('still rewrites external links for the app confirmation bridge', () => {
    const result = buildSafeHtmlDocument(
      '<a href="https://example.com/source">Source</a>',
      { allowExternalResources: false, allowScripts: false, allowForms: false },
    )

    expect(result.srcDoc).toContain('data-external-href="https://example.com/source"')
    expect(result.srcDoc).toContain('href="#"')
  })
})
