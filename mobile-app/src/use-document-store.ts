import { useEffect, useRef, useState } from 'react'
import type { DocumentRecord } from './document-types'
import {
  capturePayload,
  deleteDocumentPayload,
  initializeDocumentStore,
  payloadChanged,
  saveDocumentIndex,
  writeDocumentPayload,
} from './document-storage'
import type { PayloadSnapshot } from './document-storage'

const METADATA_WRITE_DELAY_MS = 800
const PAYLOAD_WRITE_DELAY_MS = 250

export function useDocumentStore(seedDocuments: DocumentRecord[]) {
  const [documents, setDocuments] = useState(seedDocuments)
  const [isHydrated, setIsHydrated] = useState(false)
  const hydratedRef = useRef(false)
  const payloadsRef = useRef(new Map<string, PayloadSnapshot>())
  const idsRef = useRef(new Set<string>())
  const documentsRef = useRef(documents)

  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  useEffect(() => {
    let cancelled = false
    void initializeDocumentStore(seedDocuments).then((loaded) => {
      if (cancelled) return
      payloadsRef.current = new Map(loaded.map((document) => [document.id, capturePayload(document)]))
      idsRef.current = new Set(loaded.map((document) => document.id))
      hydratedRef.current = true
      setIsHydrated(true)
      setDocuments(loaded)
    }).catch(() => {
      hydratedRef.current = true
      setIsHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [seedDocuments])

  useEffect(() => {
    if (!hydratedRef.current) return undefined
    const timer = window.setTimeout(() => {
      try {
        saveDocumentIndex(documents)
      } catch {
        // The lightweight index is retried on the next state update.
      }
    }, METADATA_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [documents])

  useEffect(() => {
    if (!hydratedRef.current) return undefined
    const timer = window.setTimeout(() => {
      const nextIds = new Set(documents.map((document) => document.id))
      for (const previousId of idsRef.current) {
        if (!nextIds.has(previousId)) {
          void deleteDocumentPayload(previousId)
          payloadsRef.current.delete(previousId)
        }
      }

      for (const document of documents) {
        if (!payloadChanged(document, payloadsRef.current.get(document.id))) continue
        const snapshot = capturePayload(document)
        void writeDocumentPayload(document)
          .then(() => {
            payloadsRef.current.set(document.id, snapshot)
          })
          .catch(() => undefined)
      }
      idsRef.current = nextIds
    }, PAYLOAD_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [documents])

  useEffect(() => {
    const flush = () => {
      if (!hydratedRef.current) return
      const current = documentsRef.current
      try { saveDocumentIndex(current) } catch { /* 下次变更时重试。 */ }
      const nextIds = new Set(current.map((document) => document.id))
      for (const previousId of idsRef.current) {
        if (!nextIds.has(previousId)) void deleteDocumentPayload(previousId).catch(() => undefined)
      }
      current.forEach((document) => {
        if (!payloadChanged(document, payloadsRef.current.get(document.id))) return
        const snapshot = capturePayload(document)
        void writeDocumentPayload(document)
          .then(() => payloadsRef.current.set(document.id, snapshot))
          .catch(() => undefined)
      })
      idsRef.current = nextIds
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  return [documents, setDocuments, isHydrated] as const
}
