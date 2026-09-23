import { describe, expect, it } from 'vitest'
import {
  getDocumentLinkBasePath,
  resolveDesktopDocumentPath,
  resolveDocumentLinkHref,
  shouldConfineDocumentLinks,
} from './html-processing'

const desktopRoot = 'E:/CodexProjects/FastViewer/mobile-app/test-fixtures/markdown-link-graph'
const level2 = `${desktopRoot}/docs/nested/level2.md`

describe('markdown link graph', () => {
  const desktopCases: Array<[string, string]> = [
    ['./peer.md', `${desktopRoot}/docs/nested/peer.md`],
    ['../level1.md', `${desktopRoot}/docs/level1.md`],
    ['../../root-peer.md', `${desktopRoot}/root-peer.md`],
    ['../../README.md', `${desktopRoot}/README.md`],
  ]

  it.each(desktopCases)('resolves desktop link %s from level2', (href, expectedPath) => {
    expect(resolveDocumentLinkHref(href, level2, false)).toEqual({ path: expectedPath, hash: '' })
    expect(resolveDesktopDocumentPath(level2.replace(/\//g, '\\'), href)?.path.replace(/\\/g, '/')).toBe(expectedPath)
  })

  it('uses archive relative path instead of zip source uri', () => {
    const context = {
      sourceUri: 'E:/Downloads/wiki.zip',
      fileName: 'level2.md',
      archiveRelativePath: 'docs/nested/level2.md',
      packageId: 'pkg-1',
    }
    expect(getDocumentLinkBasePath(context)).toBe('docs/nested/level2.md')
    expect(shouldConfineDocumentLinks(context)).toBe(true)
    expect(resolveDocumentLinkHref('../../root-peer.md', getDocumentLinkBasePath(context), true)).toEqual({
      path: 'root-peer.md',
      hash: '',
    })
  })

  it('supports Windows extended-length paths', () => {
    const extended = '\\\\?\\E:\\Docs\\nested\\current.md'
    expect(resolveDesktopDocumentPath(extended, '../peer.md')).toEqual({
      path: 'E:\\Docs\\peer.md',
      hash: '',
    })
  })
})
