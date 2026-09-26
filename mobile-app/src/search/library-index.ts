import { backgroundTasks } from '../background-tasks'
import type { StoredDocumentMetadata } from '../domain-models'

type SearchRepository = {
  listDocuments: () => Promise<StoredDocumentMetadata[]>
  listSearchText: () => Promise<Array<{ documentId: string; text: string }>>
  loadPayload: (metadata: StoredDocumentMetadata) => Promise<{ content: string }>
  saveSearchText: (documentId: string, text: string) => Promise<void>
}

let libraryIndexEnabled = true

export function setLibraryIndexEnabled(enabled: boolean) {
  libraryIndexEnabled = enabled
}

export function isLibraryIndexEnabled() {
  return libraryIndexEnabled
}

export async function ensureLibraryIndex(
  repository: SearchRepository,
  readDesktop?: (path: string) => Promise<string>,
  options?: { rebuild?: boolean },
) {
  if (!options?.rebuild && !libraryIndexEnabled) return 0
  const existing = options?.rebuild
    ? new Set<string>()
    : new Set((await repository.listSearchText()).map((row) => row.documentId))
  const missing = (await repository.listDocuments()).filter((document) => !existing.has(document.id))
  if (missing.length === 0) return 0
  const { task } = backgroundTasks.begin('library-index', options?.rebuild ? '正在重建全文索引' : '正在补建全文索引')
  try {
    for (let index = 0; index < missing.length; index += 1) {
      const document = missing[index]
      const body = await readIndexedText(repository, document, readDesktop)
      await repository.saveSearchText(document.id, body ? `${document.fileName}\n${body}` : document.fileName)
      backgroundTasks.update(task.id, { progress: (index + 1) / missing.length })
    }
    backgroundTasks.complete(task.id)
    return missing.length
  } catch (error) {
    backgroundTasks.fail(task.id, error instanceof Error ? error.message : '全文索引失败')
    throw error
  }
}

async function readIndexedText(
  repository: SearchRepository,
  document: StoredDocumentMetadata,
  readDesktop?: (path: string) => Promise<string>,
) {
  try {
    const ref = document.contentRef
    if (readDesktop && (ref.kind === 'desktop-file' || ref.kind === 'desktop-archive-entry')) {
      return await readDesktop(ref.path)
    }
    return (await repository.loadPayload(document)).content
  } catch {
    return ''
  }
}
