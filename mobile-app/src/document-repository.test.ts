// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { IndexedDbDocumentRepository } from './document-repository'
import type { DocumentRecord } from './document-types'

function record(id: string, patch: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id,
    fileName: `${id}.md`,
    fileExtension: 'md',
    fileType: 'markdown',
    fileSize: 12,
    sourceType: '测试',
    content: `# ${id}`,
    rawBase64: 'IyB0ZXN0',
    encoding: 'UTF-8',
    lastOpenedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    isFavorite: false,
    inLibrary: true,
    lastReadPosition: 0,
    ...patch,
  }
}

async function deleteDatabase(name: string) {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

describe('IndexedDB v3 文档仓储', () => {
  beforeEach(async () => {
    localStorage.clear()
    await deleteDatabase('lightpage-v3')
    await deleteDatabase('lightpage-documents-v2')
  })

  it('迁移后列表只返回元数据，正文按需读取', async () => {
    const repository = new IndexedDbDocumentRepository([record('lazy')])
    const result = await repository.migrate()
    expect(result.stage).toBe('complete')
    const metadata = (await repository.listDocuments())[0]
    expect(metadata).not.toHaveProperty('content')
    expect(metadata.storageVersion).toBe(3)
    await expect(repository.loadPayload(metadata)).resolves.toMatchObject({ content: '# lazy' })
    await expect(repository.migrate()).resolves.toMatchObject({ stage: 'complete', migratedDocuments: 1 })
  })

  it('将旧压缩包条目合并为文档包并按 README 优先排序', async () => {
    const repository = new IndexedDbDocumentRepository([
      record('chapter', { archiveStorageId: 'pkg', archiveRelativePath: '02.md', sourceType: '压缩包：手册.zip' }),
      record('readme', { archiveStorageId: 'pkg', archiveRelativePath: 'README.md', sourceType: '压缩包：手册.zip' }),
    ])
    await repository.migrate()
    expect(await repository.getPackage('pkg')).toMatchObject({ fileName: '手册.zip', durableExtraction: true, originalAvailable: false })
    const entries = await repository.listPackageEntries('pkg')
    expect(entries.map((item) => item.documentId)).toEqual(['readme', 'chapter'])
  })

  it('保存阅读状态和批注，并随文档删除清理', async () => {
    const repository = new IndexedDbDocumentRepository([record('notes')])
    await repository.migrate()
    await repository.saveReaderState({ documentId: 'notes', position: 80, progress: 0.5, updatedAt: '2026-08-01T01:00:00.000Z' })
    await repository.saveAnnotation({
      id: 'annotation-1', documentId: 'notes', kind: 'highlight', color: 'yellow', status: 'active',
      anchor: { revision: 'r1', start: 0, end: 4, exact: '正文', prefix: '', suffix: '' },
      createdAt: '2026-08-01T01:00:00.000Z', updatedAt: '2026-08-01T01:00:00.000Z',
    })
    expect(await repository.getReaderState('notes')).toMatchObject({ position: 80, progress: 0.5 })
    expect(await repository.listAnnotations('notes')).toHaveLength(1)
    await repository.deleteDocument('notes')
    expect(await repository.getDocument('notes')).toBeNull()
    expect(await repository.listAnnotations('notes')).toHaveLength(0)
  })
})
