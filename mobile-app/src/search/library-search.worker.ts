import { scanSearchText } from './library-search-scan'
import type { SearchDocument } from './library-search-scan'

addEventListener('message', (event: MessageEvent<{ query: string; documents: SearchDocument[] }>) => {
  const { query, documents } = event.data
  postMessage(scanSearchText(query, documents))
})
