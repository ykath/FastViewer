// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { buildSafeHtmlDocument } from './html-processing'

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
