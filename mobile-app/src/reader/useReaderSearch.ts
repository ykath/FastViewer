import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { finishPerformanceSpan, startPerformanceSpan } from '../performance-metrics'
import type { ReaderMode } from '../app/types'
import { highlightMatches } from './export-capture'

export function useReaderSearch({
  fileType,
  contentLength,
  readerMode,
  htmlFrameVersion,
  htmlSrcDoc,
  contentRef,
  iframeRef,
}: {
  fileType: string
  contentLength: number
  readerMode: ReaderMode
  htmlFrameVersion: number
  htmlSrcDoc: string | undefined
  contentRef: RefObject<HTMLElement | null>
  iframeRef: RefObject<HTMLIFrameElement | null>
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchCount, setSearchCount] = useState(0)
  const searchMatchesRef = useRef<HTMLElement[]>([])

  const getSearchContainer = useCallback(() => {
    if (fileType === 'html') {
      try {
        return iframeRef.current?.contentDocument?.body ?? null
      } catch {
        return null
      }
    }
    return contentRef.current
  }, [contentRef, fileType, iframeRef])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 160)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const container = getSearchContainer()
    if (!container || readerMode !== 'rendered') {
      searchMatchesRef.current = []
      setSearchCount(0)
      return
    }
    const searchStartedAt = startPerformanceSpan()
    const matches = highlightMatches(container, debouncedQuery)
    finishPerformanceSpan('document-search', searchStartedAt, {
      characters: contentLength,
      matches: matches.length,
    })
    searchMatchesRef.current = matches
    setSearchCount(matches.length)
    setSearchIndex(0)
  }, [contentLength, debouncedQuery, getSearchContainer, htmlFrameVersion, htmlSrcDoc, readerMode])

  useEffect(() => {
    searchMatchesRef.current.forEach((match, index) => {
      match.classList.toggle('active', index === searchIndex)
    })
    searchMatchesRef.current[searchIndex]?.scrollIntoView({ block: 'center' })
  }, [searchIndex, searchCount])

  return {
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    debouncedQuery,
    setDebouncedQuery,
    searchIndex,
    setSearchIndex,
    searchCount,
    setSearchCount,
    searchMatchesRef,
  }
}
