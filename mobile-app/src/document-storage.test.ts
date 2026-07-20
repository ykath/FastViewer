// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDocumentStore, readDocumentIndex } from './document-storage'
import type { DocumentRecord } from './document-types'

const legacyDocument: DocumentRecord = {
  id: 'legacy-1',
  fileName: '旧文档.md',
  fileExtension: 'md',
  fileType: 'markdown',
  fileSize: 12,
  sourceType: '旧版本',
  content: '# 正文',
  rawBase64: 'IyDmraPmloc=',
  encoding: 'UTF-8',
  lastOpenedAt: '2026-07-18T00:00:00.000Z',
  createdAt: '2026-07-18T00:00:00.000Z',
  isFavorite: false,
  inLibrary: true,
  lastReadPosition: 0,
}

describe('文档存储迁移', () => {
  beforeEach(async () => {
    localStorage.clear()
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('lightpage-documents-v2')
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
    })
  })

  it('将 v1 全量记录迁移为轻量索引与独立正文', async () => {
    localStorage.setItem('lightpage.documents.v1', JSON.stringify([legacyDocument]))
    const migrated = await initializeDocumentStore([])
    expect(migrated[0]).toMatchObject({ id: 'legacy-1', content: '# 正文', rawBase64: 'IyDmraPmloc=' })
    expect(localStorage.getItem('lightpage.documents.v1')).toBeNull()
    const index = readDocumentIndex()
    expect(index?.[0]).not.toHaveProperty('content')
    expect(index?.[0]).toMatchObject({ id: 'legacy-1', storageVersion: 2, hasRawBase64: true })

    const reloaded = await initializeDocumentStore([])
    expect(reloaded[0].content).toBe('# 正文')
  })
})
