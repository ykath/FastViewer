import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import type { DocumentMetadata, DocumentPayload, DocumentRecord } from './document-types'
import {
  deleteDocumentPayload,
  readDocumentIndex,
  readDocumentPayload,
  writeDocumentPayload,
} from './document-storage'
import type {
  ArchivePackage,
  ContentRef,
  DocumentAnnotation,
  DocumentRepository,
  MigrationResult,
  PackageEntry,
  ReaderState,
  StoredDocumentMetadata,
} from './domain-models'
import { desktopDocumentId } from './desktop-identity'

const DATABASE_NAME = 'lightpage-v3'
const DATABASE_VERSION = 2
const STORE_DOCUMENTS = 'documents'
const STORE_CONTENT = 'contentBlobs'
const STORE_READER_STATES = 'readerStates'
const STORE_ANNOTATIONS = 'annotations'
const STORE_PACKAGES = 'packages'
const STORE_PACKAGE_ENTRIES = 'packageEntries'
const STORE_META = 'meta'
const MIGRATION_KEY = 'v2-to-v3'
const V4_MIGRATION_KEY = 'v3-to-v4'

type ContentRow = DocumentPayload & { key: string }
type MetaRow = { key: string; value: unknown }

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'))
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'))
  })
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_DOCUMENTS)) {
        const store = database.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' })
        store.createIndex('lastOpenedAt', 'lastOpenedAt')
        store.createIndex('packageId', 'packageId')
      }
      if (!database.objectStoreNames.contains(STORE_CONTENT)) database.createObjectStore(STORE_CONTENT, { keyPath: 'key' })
      if (!database.objectStoreNames.contains(STORE_READER_STATES)) database.createObjectStore(STORE_READER_STATES, { keyPath: 'documentId' })
      if (!database.objectStoreNames.contains(STORE_ANNOTATIONS)) {
        const store = database.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'id' })
        store.createIndex('documentId', 'documentId')
      }
      if (!database.objectStoreNames.contains(STORE_PACKAGES)) database.createObjectStore(STORE_PACKAGES, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(STORE_PACKAGE_ENTRIES)) {
        const store = database.createObjectStore(STORE_PACKAGE_ENTRIES, { keyPath: 'id' })
        store.createIndex('packageId', 'packageId')
      }
      if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开轻页 v3 数据库'))
  })
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(storeName, mode)
    const done = transactionDone(transaction)
    const result = await requestResult(action(transaction.objectStore(storeName)))
    await done
    return result
  } finally {
    database.close()
  }
}

function contentRefFor(document: Pick<DocumentRecord, 'id' | 'archiveStorageId' | 'archiveRelativePath' | 'sourceUri'>): ContentRef {
  if (document.archiveStorageId && document.archiveRelativePath) {
    return { kind: 'android-archive-entry', packageId: document.archiveStorageId, relativePath: document.archiveRelativePath }
  }
  if (Capacitor.isNativePlatform()) {
    return { kind: 'android-private-file', path: `documents-v2/${encodeURIComponent(document.id)}/content.txt` }
  }
  if (document.sourceUri && /^[a-zA-Z]:[\\/]/.test(document.sourceUri)) {
    return { kind: 'desktop-file', path: document.sourceUri }
  }
  return { kind: 'indexeddb-blob', key: document.id }
}

function toStoredMetadata(document: DocumentRecord, contentRef = contentRefFor(document)): StoredDocumentMetadata {
  const { content, rawBase64, archiveResources, payloadLoaded, ...metadata } = document
  void content
  void payloadLoaded
  return {
    ...metadata,
    storageVersion: 4,
    hasRawBase64: Boolean(rawBase64),
    hasArchiveResources: Boolean(archiveResources && Object.keys(archiveResources).length > 0),
    contentRef,
  }
}

function packageNameFromSource(sourceType: string) {
  return sourceType.replace(/^压缩包：/, '').trim() || '文档包'
}

function naturalEntryOrder(entries: DocumentMetadata[]) {
  return [...entries].sort((left, right) => {
    const priority = (value: string) => /(^|\/)readme\.md$/i.test(value) ? 0 : /(^|\/)index\.(?:md|html?)$/i.test(value) ? 1 : 2
    const leftPath = left.archiveRelativePath ?? left.fileName
    const rightPath = right.archiveRelativePath ?? right.fileName
    return priority(leftPath) - priority(rightPath) || leftPath.localeCompare(rightPath, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export class IndexedDbDocumentRepository implements DocumentRepository {
  private readonly seedDocuments: DocumentRecord[]

  constructor(seedDocuments: DocumentRecord[]) {
    this.seedDocuments = seedDocuments
  }

  async migrate(): Promise<MigrationResult> {
    const previous = await this.getMeta<MigrationResult>(MIGRATION_KEY)
    if (previous?.stage === 'complete') return this.migrateV4(previous)

    if (!previous) {
      await this.setMeta(MIGRATION_KEY, { stage: 'pending', migratedDocuments: 0, migratedPackages: 0, readonlyFallback: false } satisfies MigrationResult)
    }

    const running: MigrationResult = { stage: 'running', migratedDocuments: 0, migratedPackages: 0, readonlyFallback: false }
    await this.setMeta(MIGRATION_KEY, running)
    try {
      const legacyMetadata = readDocumentIndex()
      const source = legacyMetadata?.length ? legacyMetadata : this.seedDocuments
      const storedDocuments: StoredDocumentMetadata[] = []
      const expectedContentLengths = new Map<string, number>()

      for (const item of source) {
        const record = item as DocumentRecord
        const ref = contentRefFor(record)
        const stored = toStoredMetadata(record, ref)
        storedDocuments.push(stored)
        await this.put(STORE_DOCUMENTS, stored)
        await this.saveReaderState({
          documentId: stored.id,
          position: stored.lastReadPosition,
          progress: stored.lastReadProgress ?? 0,
          headingId: stored.lastReadHeadingId,
          updatedAt: stored.lastOpenedAt,
        })

        if (!Capacitor.isNativePlatform()) {
          let payload: DocumentPayload | undefined
          if ('content' in record && typeof record.content === 'string') {
            payload = { content: record.content, rawBase64: record.rawBase64, archiveResources: record.archiveResources }
          } else {
            try { payload = await readDocumentPayload(item as DocumentMetadata) } catch { payload = undefined }
          }
          if (payload) await this.put(STORE_CONTENT, { key: stored.id, ...payload } satisfies ContentRow)
          if (payload) expectedContentLengths.set(stored.id, payload.content.length)
        } else if ('content' in record && typeof record.content === 'string') {
          await writeDocumentPayload(record)
          expectedContentLengths.set(stored.id, record.content.length)
        }
      }

      const groups = new Map<string, StoredDocumentMetadata[]>()
      for (const document of storedDocuments) {
        if (!document.archiveStorageId) continue
        const items = groups.get(document.archiveStorageId) ?? []
        items.push(document)
        groups.set(document.archiveStorageId, items)
      }

      for (const [storageId, documents] of groups) {
        const ordered = naturalEntryOrder(documents)
        const createdAt = ordered.reduce((value, item) => value < item.createdAt ? value : item.createdAt, ordered[0].createdAt)
        const lastOpenedAt = ordered.reduce((value, item) => value > item.lastOpenedAt ? value : item.lastOpenedAt, ordered[0].lastOpenedAt)
        await this.savePackage({
          id: storageId,
          fileName: packageNameFromSource(ordered[0].sourceType),
          sourceUri: ordered[0].sourceUri,
          storageId,
          originalAvailable: false,
          durableExtraction: true,
          lastEntryId: ordered[0].id,
          createdAt,
          lastOpenedAt,
          totalSize: ordered.reduce((total, item) => total + item.fileSize, 0),
        })
        await this.savePackageEntries(ordered.map((item, order) => ({
          id: `${storageId}:${item.archiveRelativePath ?? item.id}`,
          packageId: storageId,
          documentId: item.id,
          relativePath: item.archiveRelativePath ?? item.fileName,
          fileName: item.fileName,
          fileType: item.fileType,
          size: item.fileSize,
          order,
          isFavorite: item.isFavorite,
        })))
      }

      const verified: MigrationResult = {
        stage: 'verified',
        migratedDocuments: storedDocuments.length,
        migratedPackages: groups.size,
        readonlyFallback: false,
      }
      await this.setMeta(MIGRATION_KEY, verified)
      const listed = await this.listDocuments()
      if (listed.length !== storedDocuments.length || listed.some((item) => !item.id || !item.contentRef)) {
        throw new Error('迁移校验失败：文档数量或内容引用不一致')
      }
      for (const item of listed) {
        if (item.contentRef.kind === 'indexeddb-blob') {
          const key = item.contentRef.key
          const row = await this.get<ContentRow>(STORE_CONTENT, key)
          const expected = expectedContentLengths.get(item.id)
          if (!row || typeof row.content !== 'string' || (expected !== undefined && row.content.length !== expected)) {
            throw new Error(`迁移校验失败：${item.fileName} 正文缺失或长度不一致`)
          }
        } else if (item.contentRef.kind === 'android-private-file') {
          await Filesystem.stat({ path: item.contentRef.path, directory: Directory.Data })
        } else if (item.contentRef.kind === 'android-archive-entry') {
          await Filesystem.stat({ path: `archives/${item.contentRef.packageId}/${item.contentRef.relativePath}`, directory: Directory.Data })
        }
      }
      const complete = { ...verified, stage: 'complete' as const }
      await this.setMeta(MIGRATION_KEY, complete)
      return this.migrateV4(complete)
    } catch (error) {
      const failed: MigrationResult = {
        stage: 'failed',
        migratedDocuments: running.migratedDocuments,
        migratedPackages: running.migratedPackages,
        readonlyFallback: true,
        error: error instanceof Error ? error.message : '存储迁移失败',
      }
      await this.setMeta(MIGRATION_KEY, failed).catch(() => undefined)
      return failed
    }
  }

  private async migrateV4(base: MigrationResult): Promise<MigrationResult> {
    const previous = await this.getMeta<MigrationResult>(V4_MIGRATION_KEY)
    if (previous?.stage === 'complete') return previous
    const running: MigrationResult = { ...base, stage: 'running', readonlyFallback: false }
    await this.setMeta(V4_MIGRATION_KEY, running)
    try {
      const documents = await this.listDocuments()
      const replacedIds: string[] = []
      for (const document of documents) {
        const desktopPath = document.contentRef.kind === 'desktop-file' ? document.contentRef.path : undefined
        const nextId = desktopPath ? desktopDocumentId(desktopPath) : document.id
        const migrated = { ...document, id: nextId, storageVersion: 4 } satisfies StoredDocumentMetadata
        await this.put(STORE_DOCUMENTS, migrated)
        if (nextId !== document.id) {
          const readerState = await this.getReaderState(document.id)
          if (readerState) await this.saveReaderState({ ...readerState, documentId: nextId })
          const annotations = await this.listAnnotations(document.id)
          for (const annotation of annotations) await this.saveAnnotation({ ...annotation, documentId: nextId })
          replacedIds.push(document.id)
        }
      }
      for (const oldId of replacedIds) {
        await this.delete(STORE_DOCUMENTS, oldId)
        await this.delete(STORE_READER_STATES, oldId)
      }
      const complete: MigrationResult = {
        stage: 'complete',
        migratedDocuments: documents.length,
        migratedPackages: base.migratedPackages,
        readonlyFallback: false,
      }
      await this.setMeta(V4_MIGRATION_KEY, complete)
      return complete
    } catch (error) {
      const failed: MigrationResult = {
        ...running,
        stage: 'failed',
        readonlyFallback: true,
        error: error instanceof Error ? error.message : 'v4 存储迁移失败',
      }
      await this.setMeta(V4_MIGRATION_KEY, failed).catch(() => undefined)
      return failed
    }
  }

  listDocuments() {
    return this.getAll<StoredDocumentMetadata>(STORE_DOCUMENTS)
  }

  getDocument(id: string) {
    return this.get<StoredDocumentMetadata>(STORE_DOCUMENTS, id)
  }

  saveDocument(document: StoredDocumentMetadata) {
    return this.put(STORE_DOCUMENTS, document)
  }

  async deleteDocument(id: string) {
    const metadata = await this.getDocument(id)
    await this.delete(STORE_DOCUMENTS, id)
    await this.delete(STORE_READER_STATES, id)
    const annotations = await this.listAnnotations(id)
    await Promise.all(annotations.map((item) => this.deleteAnnotation(item.id)))
    if (metadata?.contentRef.kind === 'indexeddb-blob') await this.delete(STORE_CONTENT, metadata.contentRef.key)
    if (metadata?.contentRef.kind === 'desktop-file') await this.delete(STORE_CONTENT, metadata.id)
    if (metadata?.contentRef.kind === 'android-private-file') await deleteDocumentPayload(id)
  }

  getReaderState(documentId: string) {
    return this.get<ReaderState>(STORE_READER_STATES, documentId)
  }

  saveReaderState(state: ReaderState) {
    return this.put(STORE_READER_STATES, state)
  }

  async listAnnotations(documentId: string) {
    return this.getAllByIndex<DocumentAnnotation>(STORE_ANNOTATIONS, 'documentId', documentId)
  }

  saveAnnotation(annotation: DocumentAnnotation) {
    return this.put(STORE_ANNOTATIONS, annotation)
  }

  deleteAnnotation(id: string) {
    return this.delete(STORE_ANNOTATIONS, id)
  }

  getPackage(id: string) {
    return this.get<ArchivePackage>(STORE_PACKAGES, id)
  }

  savePackage(item: ArchivePackage) {
    return this.put(STORE_PACKAGES, item)
  }

  async deletePackage(id: string) {
    const entries = await this.listPackageEntries(id)
    await Promise.all(entries.map((entry) => this.delete(STORE_PACKAGE_ENTRIES, entry.id)))
    await this.delete(STORE_PACKAGES, id)
  }

  listPackageEntries(packageId: string) {
    return this.getAllByIndex<PackageEntry>(STORE_PACKAGE_ENTRIES, 'packageId', packageId)
      .then((items) => items.sort((left, right) => left.order - right.order))
  }

  async savePackageEntries(entries: PackageEntry[]) {
    for (const entry of entries) await this.put(STORE_PACKAGE_ENTRIES, entry)
  }

  async savePayload(document: DocumentRecord) {
    if (Capacitor.isNativePlatform()) {
      if (document.archiveStorageId && document.archiveRelativePath) return contentRefFor(document)
      await writeDocumentPayload(document)
      return contentRefFor(document)
    }
    if (document.sourceUri && /^[a-zA-Z]:[\\/]/.test(document.sourceUri)) {
      return contentRefFor(document)
    }
    await this.put(STORE_CONTENT, {
      key: document.id,
      content: document.content,
      rawBase64: document.rawBase64,
      archiveResources: document.archiveResources,
    } satisfies ContentRow)
    return contentRefFor(document)
  }

  async loadPayload(metadata: StoredDocumentMetadata): Promise<DocumentPayload> {
    if (metadata.contentRef.kind === 'android-private-file' || metadata.contentRef.kind === 'android-archive-entry') {
      return readDocumentPayload(metadata)
    }
    const row = await this.get<ContentRow>(STORE_CONTENT, metadata.contentRef.kind === 'indexeddb-blob' ? metadata.contentRef.key : metadata.id)
    if (!row) {
      // Desktop records migrated before v3 can still be recovered from the v2 payload store.
      return readDocumentPayload(metadata)
    }
    return { content: row.content, rawBase64: row.rawBase64, archiveResources: row.archiveResources }
  }

  toMetadata(document: DocumentRecord, contentRef?: ContentRef) {
    return toStoredMetadata(document, contentRef)
  }

  getAppState<T>(key: string) {
    return this.getMeta<T>(`app-state:${key}`).then((value) => value ?? null)
  }

  setAppState(key: string, value: unknown) {
    return this.setMeta(`app-state:${key}`, value)
  }

  private async get<T>(store: string, key: IDBValidKey): Promise<T | null> {
    return (await withStore<T | undefined>(store, 'readonly', (target) => target.get(key))) ?? null
  }

  private getAll<T>(store: string) {
    return withStore<T[]>(store, 'readonly', (target) => target.getAll())
  }

  private async getAllByIndex<T>(store: string, index: string, key: IDBValidKey) {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(store, 'readonly')
      const done = transactionDone(transaction)
      const result = await requestResult(transaction.objectStore(store).index(index).getAll(key)) as T[]
      await done
      return result
    } finally {
      database.close()
    }
  }

  private put(store: string, value: unknown) {
    return withStore<IDBValidKey>(store, 'readwrite', (target) => target.put(value)).then(() => undefined)
  }

  private delete(store: string, key: IDBValidKey) {
    return withStore<undefined>(store, 'readwrite', (target) => target.delete(key)).then(() => undefined)
  }

  private async getMeta<T>(key: string) {
    const row = await this.get<MetaRow>(STORE_META, key)
    return row?.value as T | undefined
  }

  private setMeta(key: string, value: unknown) {
    return this.put(STORE_META, { key, value } satisfies MetaRow)
  }
}
