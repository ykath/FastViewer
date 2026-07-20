import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { DocumentMetadata, DocumentPayload, DocumentRecord } from './document-types'

const LEGACY_INDEX_KEY = 'lightpage.documents.v1'
const INDEX_KEY = 'lightpage.documents.v2'
const NATIVE_DOCUMENT_ROOT = 'documents-v2'
const WEB_DATABASE = 'lightpage-documents-v2'
const WEB_STORE = 'payloads'

function toMetadata(document: DocumentRecord): DocumentMetadata {
  const { content, rawBase64, archiveResources, ...metadata } = document
  void content
  return {
    ...metadata,
    storageVersion: 2,
    hasRawBase64: Boolean(rawBase64),
    hasArchiveResources: Boolean(archiveResources && Object.keys(archiveResources).length > 0),
  }
}

function toPayload(document: DocumentRecord): DocumentPayload {
  return {
    content: document.content,
    rawBase64: document.rawBase64,
    archiveResources: document.archiveResources,
  }
}

function payloadDirectory(id: string) {
  return `${NATIVE_DOCUMENT_ROOT}/${encodeURIComponent(id)}`
}

function readString(data: string | Blob) {
  if (typeof data === 'string') return Promise.resolve(data)
  return data.text()
}

async function nativeWritePayload(document: DocumentRecord) {
  const dir = payloadDirectory(document.id)
  await Filesystem.writeFile({
    path: `${dir}/content.txt`,
    data: document.content,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  })

  if (document.rawBase64) {
    await Filesystem.writeFile({
      path: `${dir}/original.bin`,
      data: document.rawBase64,
      directory: Directory.Data,
      recursive: true,
    })
  } else {
    await nativeDeleteFile(`${dir}/original.bin`)
  }

  if (document.archiveResources && Object.keys(document.archiveResources).length > 0) {
    await Filesystem.writeFile({
      path: `${dir}/resources.json`,
      data: JSON.stringify(document.archiveResources),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    })
  } else {
    await nativeDeleteFile(`${dir}/resources.json`)
  }
}

async function nativeReadPayload(metadata: DocumentMetadata): Promise<DocumentPayload> {
  const dir = payloadDirectory(metadata.id)
  const contentResult = await Filesystem.readFile({
    path: `${dir}/content.txt`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  })
  const content = await readString(contentResult.data)

  let rawBase64: string | undefined
  if (metadata.hasRawBase64) {
    const result = await Filesystem.readFile({ path: `${dir}/original.bin`, directory: Directory.Data })
    rawBase64 = await readString(result.data)
  }

  let archiveResources: Record<string, string> | undefined
  if (metadata.hasArchiveResources) {
    const result = await Filesystem.readFile({
      path: `${dir}/resources.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    archiveResources = JSON.parse(await readString(result.data)) as Record<string, string>
  }

  return { content, rawBase64, archiveResources }
}

async function nativeDeleteFile(path: string) {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data })
  } catch {
    // Missing optional payload files are expected during updates and migration.
  }
}

async function nativeDeletePayload(id: string) {
  try {
    await Filesystem.rmdir({ path: payloadDirectory(id), directory: Directory.Data, recursive: true })
  } catch {
    // The document may already have been removed by an OS cleanup or a previous migration attempt.
  }
}

async function nativeCleanupOrphans(validIds: Set<string>) {
  try {
    const result = await Filesystem.readdir({ path: NATIVE_DOCUMENT_ROOT, directory: Directory.Data })
    await Promise.all(result.files
      .filter((entry) => entry.type === 'directory' && !validIds.has(decodeURIComponent(entry.name)))
      .map((entry) => Filesystem.rmdir({
        path: `${NATIVE_DOCUMENT_ROOT}/${entry.name}`,
        directory: Directory.Data,
        recursive: true,
      })))
  } catch {
    // 首次启动或系统已清理目录时不存在孤儿数据。
  }
}

function openWebDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(WEB_DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WEB_STORE)) {
        request.result.createObjectStore(WEB_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地文档数据库'))
  })
}

async function withWebStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openWebDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(WEB_STORE, mode)
      const request = action(transaction.objectStore(WEB_STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('文档数据库操作失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('文档数据库事务失败'))
    })
  } finally {
    database.close()
  }
}

function webWritePayload(document: DocumentRecord) {
  return withWebStore('readwrite', (store) => store.put({ id: document.id, ...toPayload(document) }))
}

async function webReadPayload(id: string): Promise<DocumentPayload> {
  const result = await withWebStore<Record<string, unknown> | undefined>('readonly', (store) => store.get(id))
  if (!result || typeof result.content !== 'string') {
    throw new Error('文档正文不存在')
  }
  return {
    content: result.content,
    rawBase64: typeof result.rawBase64 === 'string' ? result.rawBase64 : undefined,
    archiveResources:
      result.archiveResources && typeof result.archiveResources === 'object'
        ? (result.archiveResources as Record<string, string>)
        : undefined,
  }
}

function webDeletePayload(id: string) {
  return withWebStore('readwrite', (store) => store.delete(id))
}

async function webCleanupOrphans(validIds: Set<string>) {
  const keys = await withWebStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
  await Promise.all(keys
    .map(String)
    .filter((id) => !validIds.has(id))
    .map(webDeletePayload))
}

async function cleanupOrphanPayloads(ids: string[]) {
  const validIds = new Set(ids)
  if (Capacitor.isNativePlatform()) await nativeCleanupOrphans(validIds)
  else await webCleanupOrphans(validIds)
}

export function readDocumentIndex(): DocumentMetadata[] | null {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DocumentMetadata[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveDocumentIndex(documents: DocumentRecord[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(documents.map(toMetadata)))
}

export async function writeDocumentPayload(document: DocumentRecord) {
  if (Capacitor.isNativePlatform()) {
    await nativeWritePayload(document)
  } else {
    await webWritePayload(document)
  }
}

export async function deleteDocumentPayload(id: string) {
  if (Capacitor.isNativePlatform()) {
    await nativeDeletePayload(id)
  } else {
    await webDeletePayload(id)
  }
}

async function readDocumentPayload(metadata: DocumentMetadata) {
  return Capacitor.isNativePlatform() ? nativeReadPayload(metadata) : webReadPayload(metadata.id)
}

async function loadFromMetadata(metadata: DocumentMetadata[]) {
  return Promise.all(metadata.map(async (item) => {
    const stored = { ...item } as Partial<DocumentMetadata>
    delete stored.storageVersion
    delete stored.hasRawBase64
    delete stored.hasArchiveResources
    return { ...stored, ...(await readDocumentPayload(item)) } as DocumentRecord
  }))
}

function readLegacyDocuments() {
  try {
    const raw = localStorage.getItem(LEGACY_INDEX_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DocumentRecord[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function persistSnapshot(documents: DocumentRecord[]) {
  await Promise.all(documents.map(writeDocumentPayload))
  saveDocumentIndex(documents)
}

export async function initializeDocumentStore(seedDocuments: DocumentRecord[]) {
  const metadata = readDocumentIndex()
  if (metadata) {
    try {
      const loaded = await loadFromMetadata(metadata)
      await cleanupOrphanPayloads(loaded.map((document) => document.id))
      return loaded
    } catch {
      // A partial write must not make the app unusable. Fall through to the legacy snapshot if available.
    }
  }

  const legacy = readLegacyDocuments()
  const initial = legacy ?? seedDocuments
  await persistSnapshot(initial)
  await cleanupOrphanPayloads(initial.map((document) => document.id))
  if (legacy) localStorage.removeItem(LEGACY_INDEX_KEY)
  return initial
}

export type PayloadSnapshot = Pick<DocumentRecord, 'content' | 'rawBase64' | 'archiveResources'>

export function capturePayload(document: DocumentRecord): PayloadSnapshot {
  return {
    content: document.content,
    rawBase64: document.rawBase64,
    archiveResources: document.archiveResources,
  }
}

export function payloadChanged(document: DocumentRecord, previous?: PayloadSnapshot) {
  return !previous
    || previous.content !== document.content
    || previous.rawBase64 !== document.rawBase64
    || previous.archiveResources !== document.archiveResources
}
