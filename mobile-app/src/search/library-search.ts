import type { WorkspaceSearchHit } from '../domain-models'
import { scanSearchText } from './library-search-scan'
import type { LibraryHit, SearchDocument } from './library-search-scan'

export type { LibraryHit, SearchDocument }
export type HomeSearchResult = {
  library: LibraryHit[]
  pinned: WorkspaceSearchHit[]
}

export function searchLibrary(query: string, documents: SearchDocument[]) {
  if (!query.trim() || documents.length === 0) return Promise.resolve([] as LibraryHit[])
  if (typeof Worker === 'undefined') return Promise.resolve(scanSearchText(query, documents))
  return new Promise<LibraryHit[]>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./library-search.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      resolve(scanSearchText(query, documents))
      return
    }
    let settled = false
    const finish = (hits: LibraryHit[]) => {
      if (settled) return
      settled = true
      worker.terminate()
      resolve(hits)
    }
    worker.onmessage = (event: MessageEvent<LibraryHit[]>) => finish(event.data)
    worker.onerror = () => finish(scanSearchText(query, documents))
    worker.postMessage({ query, documents })
  })
}
