export type SearchDocument = {
  documentId: string
  fileName: string
  text: string
}

export type LibraryHit = {
  documentId: string
  fileName: string
  heading: string
  snippet: string
  hitCount: number
}

const SNIPPET_RADIUS = 48

export function scanSearchText(query: string, documents: SearchDocument[]): LibraryHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const hits: LibraryHit[] = []
  for (const document of documents) {
    const haystack = document.text.toLocaleLowerCase()
    let from = 0
    let count = 0
    let first = -1
    while (from < haystack.length) {
      const index = haystack.indexOf(needle, from)
      if (index < 0) break
      if (first < 0) first = index
      count += 1
      from = index + Math.max(needle.length, 1)
      if (count >= 99) break
    }
    if (count === 0) continue
    const start = Math.max(0, first - SNIPPET_RADIUS)
    const snippet = document.text.slice(start, first + needle.length + SNIPPET_RADIUS).replace(/\s+/g, ' ').trim()
    hits.push({
      documentId: document.documentId,
      fileName: document.fileName,
      heading: headingBefore(document.text, first) || document.fileName,
      snippet,
      hitCount: count,
    })
  }
  return hits
}

function headingBefore(text: string, index: number) {
  const matches = text.slice(0, index).match(/^#{1,6}[ \t]+(.+)$/gm)
  if (!matches || matches.length === 0) return ''
  return matches[matches.length - 1].replace(/^#{1,6}[ \t]+/, '').trim()
}
