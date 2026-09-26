import { Capacitor } from '@capacitor/core'
import { Share } from '@capacitor/share'
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import {
  annotationsToMarkdown,
  applyAnnotationHighlights,
  captureSelectionAnchor,
  createBookmarkAnchor,
} from '../annotations'
import { clamp } from '../app/records'
import type { NativeSelectionAction, ReaderMode, ReaderSelectionAction, ToastState } from '../app/types'
import type { AnnotationColor, DocumentAnnotation, DocumentRepository } from '../domain-models'
import { desktopPlatform } from '../desktop-platform'
import type { DocumentRecord } from '../document-types'
import type { HeadingItem } from '../html-processing'
import { findActiveHeading } from './export-capture'

export function useReaderAnnotations({
  document,
  readerMode,
  contentRef,
  scrollRef,
  iframeRef,
  contentRevision,
  renderPlainText,
  activeHeadingId,
  annotations,
  setAnnotations,
  annotationRenderTick,
  annotationRepository,
  onShowToast,
  headings,
  selectionAction,
  setSelectionAction,
  setReaderToolsOpen,
  setShareCardText,
  setAnnotationsOpen,
}: {
  document: DocumentRecord
  readerMode: ReaderMode
  contentRef: RefObject<HTMLElement | null>
  scrollRef: RefObject<HTMLElement | null>
  iframeRef: RefObject<HTMLIFrameElement | null>
  contentRevision: string
  renderPlainText: string
  activeHeadingId: string
  annotations: DocumentAnnotation[]
  setAnnotations: Dispatch<SetStateAction<DocumentAnnotation[]>>
  annotationRenderTick: number
  annotationRepository: DocumentRepository
  onShowToast: (message: string, tone?: ToastState['tone']) => void
  headings: HeadingItem[]
  selectionAction: ReaderSelectionAction | null
  setSelectionAction: Dispatch<SetStateAction<ReaderSelectionAction | null>>
  setReaderToolsOpen: Dispatch<SetStateAction<boolean>>
  setShareCardText: Dispatch<SetStateAction<string | null>>
  setAnnotationsOpen: Dispatch<SetStateAction<boolean>>
}) {
  const noteResolverRef = useRef<((value: string | null) => void) | null>(null)
  const [noteDraft, setNoteDraft] = useState<{ title: string; value: string } | null>(null)
  const askNote = useCallback((title: string, initial: string) => new Promise<string | null>((resolve) => {
    noteResolverRef.current?.(null)
    noteResolverRef.current = resolve
    setNoteDraft({ title, value: initial })
  }), [])
  const finishNote = (value: string | null) => {
    noteResolverRef.current?.(value)
    noteResolverRef.current = null
    setNoteDraft(null)
  }

  useEffect(() => {
    if (document.fileType !== 'markdown' || readerMode !== 'rendered') return undefined
    const frame = window.requestAnimationFrame(() => {
      if (contentRef.current) applyAnnotationHighlights(contentRef.current, annotations)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [annotationRenderTick, annotations, contentRef, document.content, document.fileType, readerMode])

  const readReaderSelection = useCallback((): ReaderSelectionAction | null => {
    if (document.fileType !== 'markdown' || readerMode !== 'rendered' || !contentRef.current || !contentRevision) return null
    const progressiveText = contentRef.current.classList.contains('progressive-markdown') ? renderPlainText : undefined
    const anchor = captureSelectionAnchor(contentRef.current, contentRevision, activeHeadingId || undefined, progressiveText)
    const selection = window.getSelection()
    if (!anchor || !selection || selection.rangeCount === 0) {
      return null
    }
    const overlaps = annotations.some((item) => item.status === 'active'
      && item.kind !== 'bookmark'
      && anchor.start < item.anchor.end
      && anchor.end > item.anchor.start)
    if (overlaps) {
      onShowToast('所选文字与已有批注重叠', 'warning')
      return null
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    return {
      anchor,
      x: clamp(rect.left + rect.width / 2, 88, window.innerWidth - 88),
      y: Math.max(68, rect.top - 12),
    }
  }, [activeHeadingId, annotations, contentRef, contentRevision, document.fileType, onShowToast, readerMode, renderPlainText])

  const captureReaderSelection = () => {
    if (Capacitor.isNativePlatform()) {
      setSelectionAction(null)
      return
    }
    setSelectionAction(readReaderSelection())
  }

  const saveSelectionAnnotation = useCallback(async (kind: 'highlight' | 'note', action = selectionAction, color: AnnotationColor = 'yellow') => {
    if (!action) return
    let note: string | undefined
    if (kind === 'note') {
      const value = await askNote('输入批注（最多 2000 字）', '')
      if (value === null) return
      note = value.trim().slice(0, 2000)
    }
    const now = new Date().toISOString()
    const item: DocumentAnnotation = {
      id: crypto.randomUUID(),
      documentId: document.id,
      kind,
      anchor: action.anchor,
      note,
      color: kind === 'highlight' ? color : 'yellow',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    await annotationRepository.saveAnnotation(item)
    setAnnotations((current) => [...current, item])
    setSelectionAction(null)
    window.getSelection()?.removeAllRanges()
    onShowToast(kind === 'note' ? '批注已保存' : '已高亮所选文字', 'success')
  }, [annotationRepository, askNote, document.id, onShowToast, selectionAction, setAnnotations, setSelectionAction])

  const highlightCurrentSelection = async (color: AnnotationColor = 'yellow') => {
    const current = readReaderSelection()
    if (!current) {
      onShowToast('请先选择要高亮的文字', 'warning')
      return
    }
    await saveSelectionAnnotation('highlight', current, color)
  }

  const handleNativeSelectionAction = useCallback((action: NativeSelectionAction) => {
    setReaderToolsOpen(false)
    const currentSelection = readReaderSelection()
    if (!currentSelection) {
      onShowToast('未能读取所选文字，请重新选择', 'warning')
      return
    }
    if (action === 'card') {
      setShareCardText(currentSelection.anchor.exact)
      setSelectionAction(null)
      window.getSelection()?.removeAllRanges()
      return
    }
    void saveSelectionAnnotation(action, currentSelection)
  }, [onShowToast, readReaderSelection, saveSelectionAnnotation, setReaderToolsOpen, setSelectionAction, setShareCardText])

  const addBookmark = async () => {
    if (!contentRef.current || document.fileType !== 'markdown') return
    const now = new Date().toISOString()
    const item: DocumentAnnotation = {
      id: crypto.randomUUID(),
      documentId: document.id,
      kind: 'bookmark',
      anchor: createBookmarkAnchor(
        contentRef.current,
        contentRevision,
        activeHeadingId || findActiveHeading(document.fileType, headings, iframeRef.current) || undefined,
        contentRef.current.classList.contains('progressive-markdown') ? renderPlainText : undefined,
      ),
      color: 'yellow',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    await annotationRepository.saveAnnotation(item)
    setAnnotations((current) => [...current, item])
    onShowToast('书签已添加', 'success')
  }

  const removeAnnotation = async (id: string) => {
    await annotationRepository.deleteAnnotation(id)
    setAnnotations((current) => current.filter((item) => item.id !== id))
  }

  const editAnnotation = async (item: DocumentAnnotation) => {
    const value = await askNote('编辑批注（最多 2000 字）', item.note ?? '')
    if (value === null) return
    const updated: DocumentAnnotation = {
      ...item,
      kind: 'note',
      note: value.trim().slice(0, 2000),
      updatedAt: new Date().toISOString(),
    }
    await annotationRepository.saveAnnotation(updated)
    setAnnotations((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate))
    onShowToast('批注已更新', 'success')
  }

  const jumpToAnnotation = (item: DocumentAnnotation) => {
    if (item.status === 'orphaned') {
      onShowToast('原文已变化，请重新关联此批注', 'warning')
      return
    }
    setAnnotationsOpen(false)
    const scrollToItem = () => {
      if (item.kind === 'bookmark' && item.anchor.headingId) {
        const target = window.document.getElementById(item.anchor.headingId)
        const scroller = scrollRef.current
        if (!target || !scroller) return
        const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        scroller.scrollTo({ top, behavior: 'auto' })
        return
      }
      contentRef.current?.querySelector<HTMLElement>(`mark[data-annotation-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'center' })
    }
    window.setTimeout(scrollToItem, 0)
    window.setTimeout(scrollToItem, 250)
  }

  const exportAnnotations = async () => {
    if (annotations.length === 0) {
      onShowToast('当前文档没有批注', 'warning')
      return
    }
    const text = annotationsToMarkdown(document.fileName, annotations)
    if (desktopPlatform.isDesktop()) {
      const saved = await desktopPlatform.saveTextFile(text, `${document.fileName.replace(/\.[^.]+$/, '')}-批注.md`)
      if (saved) onShowToast('批注摘要已导出', 'success')
      return
    }
    if (Capacitor.isNativePlatform()) {
      await Share.share({ title: `${document.fileName} 批注`, text, dialogTitle: '分享批注摘要' })
    } else {
      await navigator.clipboard.writeText(text)
      onShowToast('批注摘要已复制', 'success')
    }
  }

  return {
    readReaderSelection,
    captureReaderSelection,
    saveSelectionAnnotation,
    handleNativeSelectionAction,
    addBookmark,
    removeAnnotation,
    editAnnotation,
    jumpToAnnotation,
    exportAnnotations,
    noteDraft,
    setNoteDraft,
    finishNote,
    highlightCurrentSelection,
  }
}
