import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentRecord } from './document-types'
import { IndexedDbDocumentRepository } from './document-repository'
import { loadLegacyDocumentsReadonly } from './document-storage'

const METADATA_WRITE_DELAY_MS = 600
const PAYLOAD_WRITE_DELAY_MS = 250

export function useDocumentStore(seedDocuments: DocumentRecord[]) {
  const [repository] = useState(() => new IndexedDbDocumentRepository(seedDocuments))
  const [documents, setDocuments] = useState<DocumentRecord[]>(() => seedDocuments.map((item) => ({ ...item, payloadLoaded: true })))
  const [isHydrated, setIsHydrated] = useState(false)
  const hydratedRef = useRef(false)
  const readonlyFallbackRef = useRef(false)
  const savedMetadataRef = useRef(new Map<string, string>())
  const savedPayloadRef = useRef(new Map<string, string>())
  const idsRef = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    void repository.migrate().then(async (migration) => {
      if (cancelled) return
      if (migration.stage !== 'complete') throw new Error(migration.error ?? '存储迁移未完成')
      const metadata = await repository.listDocuments()
      if (cancelled) return
      const loaded = metadata
        .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
        .map((item) => ({
          ...item,
          content: '',
          rawBase64: undefined,
          archiveResources: undefined,
          payloadLoaded: false,
        } satisfies DocumentRecord))
      idsRef.current = new Set(loaded.map((item) => item.id))
      savedMetadataRef.current = new Map(loaded.map((item) => [item.id, metadataFingerprint(item)]))
      hydratedRef.current = true
      setDocuments(loaded)
      setIsHydrated(true)
    }).catch(async () => {
      // Migration failure is deliberately non-destructive. Keep legacy data available without writing over it.
      readonlyFallbackRef.current = true
      const legacy = await loadLegacyDocumentsReadonly().catch(() => null)
      if (cancelled) return
      hydratedRef.current = true
      const fallback = legacy?.length ? legacy : seedDocuments
      idsRef.current = new Set(fallback.map((item) => item.id))
      setDocuments(fallback.map((item) => ({ ...item, payloadLoaded: true })))
      setIsHydrated(true)
    })
    return () => { cancelled = true }
  }, [repository, seedDocuments])

  const loadDocument = useCallback(async (id: string) => {
    const existing = documents.find((item) => item.id === id)
    if (existing?.payloadLoaded !== false) return existing ?? null
    const metadata = await repository.getDocument(id)
    if (!metadata) return null
    const payload = await repository.loadPayload(metadata)
    const loaded: DocumentRecord = { ...metadata, ...payload, payloadLoaded: true }
    setDocuments((items) => items.map((item) => item.id === id ? loaded : item))
    savedPayloadRef.current.set(id, payloadFingerprint(loaded))
    return loaded
  }, [documents, repository])

  useEffect(() => {
    if (!hydratedRef.current || readonlyFallbackRef.current) return undefined
    const timer = window.setTimeout(() => {
      const nextIds = new Set(documents.map((item) => item.id))
      for (const id of idsRef.current) {
        if (!nextIds.has(id)) void repository.deleteDocument(id).catch(() => undefined)
      }
      documents.forEach((document) => {
        const fingerprint = metadataFingerprint(document)
        if (savedMetadataRef.current.get(document.id) === fingerprint) return
        const metadata = repository.toMetadata(document)
        void repository.saveDocument(metadata)
          .then(() => savedMetadataRef.current.set(document.id, fingerprint))
          .catch(() => undefined)
      })
      idsRef.current = nextIds
    }, METADATA_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [documents, repository])

  useEffect(() => {
    if (!hydratedRef.current || readonlyFallbackRef.current) return undefined
    const timer = window.setTimeout(() => {
      documents.forEach((document) => {
        if (document.payloadLoaded === false) return
        if (document.sourceUri && /^[a-zA-Z]:[\\/]/.test(document.sourceUri)) return
        const fingerprint = payloadFingerprint(document)
        if (savedPayloadRef.current.get(document.id) === fingerprint) return
        void repository.savePayload(document)
          .then((contentRef) => repository.saveDocument(repository.toMetadata(document, contentRef)))
          .then(() => savedPayloadRef.current.set(document.id, fingerprint))
          .catch(() => undefined)
      })
    }, PAYLOAD_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [documents, repository])

  return [documents, setDocuments, isHydrated, loadDocument, repository] as const
}

function metadataFingerprint(document: DocumentRecord) {
  return JSON.stringify({
    fileName: document.fileName,
    fileSize: document.fileSize,
    sourceType: document.sourceType,
    sourceUri: document.sourceUri,
    sourceUrl: document.sourceUrl,
    sourceAdapter: document.sourceAdapter,
    encoding: document.encoding,
    lastOpenedAt: document.lastOpenedAt,
    isFavorite: document.isFavorite,
    inLibrary: document.inLibrary,
    lastReadPosition: document.lastReadPosition,
    lastReadHeadingId: document.lastReadHeadingId,
    lastReadProgress: document.lastReadProgress,
    trustedHtml: document.trustedHtml,
    allowHtmlScripts: document.allowHtmlScripts,
    allowHtmlForms: document.allowHtmlForms,
    allowHtmlPopups: document.allowHtmlPopups,
    packageId: document.packageId,
    packageName: document.packageName,
    contentRevision: document.contentRevision,
  })
}

function payloadFingerprint(document: DocumentRecord) {
  return `${document.content.length}:${document.rawBase64?.length ?? 0}:${Object.keys(document.archiveResources ?? {}).length}`
}
