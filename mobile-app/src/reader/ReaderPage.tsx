import { FILE_SIZE_DANGER, FastViewerFiles, type NativeSelectionAction, type ReaderMode, type ReaderSelectionAction, type ShareCardTemplate, type ToastState } from '../app/types'
import { bytesToBase64, clamp, directoryFileDetails, splitShareCardText } from '../app/records'
import { canvasToPngBytes, findActiveHeading, measureFrameDocument } from './export-capture'
import { DesktopPopover, DirectorySortControl, HtmlReader, MenuAction, PermissionToggle, RenderErrorBoundary, Sheet, TextReader } from '../ui/chrome'
import { FileMenu } from './FileMenu'
import { useReaderAnnotations } from './useReaderAnnotations'
import { useReaderSearch } from './useReaderSearch'
import { useReaderExport } from './useReaderExport'
import { AlertCircle, ChevronLeft, ChevronDown, ChevronUp, Copy, FileCode2, FileText, FolderOpen, ImageDown, ListTree, Loader2, Menu, MessageSquare, Moon, Pin, PinOff, Search, Share2, ShieldCheck, SlidersHorizontal, Sun, X } from 'lucide-react'
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { decodeWithEncoding, base64ToBytes, ENCODING_OPTIONS } from '../encoding'
import type { EncodingLabel } from '../encoding'
import type { DocumentRecord } from '../document-types'
import { finishPerformanceSpan, startPerformanceSpan } from '../performance-metrics'
import { buildSafeHtmlDocument, classifyMarkdownLink, extractMarkdownHeadings, getDocumentLinkBasePath, isDesktopAbsolutePath, isSameDocumentPath, resolveDesktopDocumentPath, resolveDocumentLinkHref, rewriteRelativeResources, shouldConfineDocumentLinks } from '../html-processing'
import type { HeadingItem } from '../html-processing'
import { nextThemePreference, themePreferenceLabel } from '../reader-settings'
import type { ReaderSettings, ThemeMode } from '../reader-settings'
import { desktopPlatform } from '../desktop-platform'
import type { DesktopDirectoryListing } from '../desktop-platform'
import type { DocumentAnnotation, DocumentRepository, BackgroundTask } from '../domain-models'
import { displayDirectoryPath, sortDirectoryDocuments } from '../desktop-directories'
import type { DirectorySortMode } from '../desktop-directories'
import { backgroundTasks } from '../background-tasks'
import { buildRichTextPayload, waitForRichTextRender, writePlainTextToClipboard, writeRichTextToClipboard } from '../rich-text-copy'
import { canonicalText, reanchorAnnotation, sha256Text } from '../annotations'
import { contentRenderRevision } from '../render-revision'
import '../App.css'
export type ReaderPageProps = {
  document: DocumentRecord
  packageDocuments: DocumentRecord[]
  settings: ReaderSettings
  resolvedTheme: ThemeMode
  onBack: () => void
  onUpdate: (patch: Partial<DocumentRecord>) => void
  onReload?: () => Promise<boolean>
  onShowToast: (message: string, tone?: ToastState['tone']) => void
  onSetSettings: (settings: ReaderSettings) => void
  onOpenPackageDocument: (document: DocumentRecord) => void
  onOpenPackageDocumentFromLink: (
    document: DocumentRecord,
    options: { fromDocumentLink: boolean; headingId: string },
  ) => void
  onOpenDesktopDocument: (
    path: string,
    options: { fromDocumentLink: boolean; headingId: string },
  ) => void
  linkNavigationHeadingId: string | null
  onConsumeLinkNavigationHeading: () => void
  annotationRepository: DocumentRepository
  directoryListing: DesktopDirectoryListing | null
  directorySortMode: DirectorySortMode
  directoryPinned: boolean
  onToggleDirectoryPin: () => void
  onOpenDirectoryDocument: (path: string) => void
  onDirectorySortModeChange: (mode: DirectorySortMode) => void
}

export function ReaderPage({
  document,
  packageDocuments,
  settings,
  resolvedTheme,
  onBack,
  onUpdate,
  onReload,
  onShowToast,
  onSetSettings,
  onOpenPackageDocument,
  onOpenPackageDocumentFromLink,
  onOpenDesktopDocument,
  linkNavigationHeadingId,
  onConsumeLinkNavigationHeading,
  annotationRepository,
  directoryListing,
  directorySortMode,
  directoryPinned,
  onToggleDirectoryPin,
  onOpenDirectoryDocument,
  onDirectorySortModeChange,
}: ReaderPageProps) {
  const isDesktop = desktopPlatform.isDesktop()
  const [tocOpen, setTocOpen] = useState(false)
  const [desktopTocOpen, setDesktopTocOpen] = useState(true)
  const [desktopDirectoryMode, setDesktopDirectoryMode] = useState<'chapters' | 'files' | 'annotations'>('chapters')
  const [annotationKindFilter, setAnnotationKindFilter] = useState<'all' | 'highlight' | 'note' | 'bookmark'>('all')
  const [annotationStatusFilter, setAnnotationStatusFilter] = useState<'all' | 'active' | 'orphaned'>('all')
  const [tocQuery, setTocQuery] = useState('')
  const [tocExpanded, setTocExpanded] = useState(true)
  const [activeHeadingId, setActiveHeadingId] = useState(document.lastReadHeadingId ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  const [readerToolsOpen, setReaderToolsOpen] = useState(false)
  const [readerToolbarY, setReaderToolbarY] = useState<number | null>(settings.readerToolbarY)
  const [encodingOpen, setEncodingOpen] = useState(false)
  const [htmlPermissionsOpen, setHtmlPermissionsOpen] = useState(false)
  const [imageExportOpen, setImageExportOpen] = useState(false)
  const [packageOpen, setPackageOpen] = useState(false)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([])
  const [contentRevision, setContentRevision] = useState(document.contentRevision ?? '')
  const [renderPlainText, setRenderPlainText] = useState('')
  const [annotationRenderTick, setAnnotationRenderTick] = useState(0)
  const [richCopyRenderAll, setRichCopyRenderAll] = useState(false)
  const [selectionAction, setSelectionAction] = useState<ReaderSelectionAction | null>(null)
  const [shareCardText, setShareCardText] = useState<string | null>(null)
  const [shareCardTemplate, setShareCardTemplate] = useState<ShareCardTemplate>('simple')
  const [shareCardSourceUrl, setShareCardSourceUrl] = useState('')
  const [shareCardQrEnabled, setShareCardQrEnabled] = useState(false)
  const [shareCardQrDataUrl, setShareCardQrDataUrl] = useState('')
  const [removedShareCardPages, setRemovedShareCardPages] = useState<number[]>([])
  const [immersive, setImmersive] = useState(false)
  const [readerMode, setReaderMode] = useState<ReaderMode>(
    document.fileSize >= FILE_SIZE_DANGER ? 'source' : 'rendered',
  )
  const [renderFailed, setRenderFailed] = useState(false)
  const [markdownRenderAttempt, setMarkdownRenderAttempt] = useState(0)
  const markdownContentRevision = useMemo(
    () => contentRenderRevision(document.content),
    [document.content],
  )
  const [allowExternalOnce, setAllowExternalOnce] = useState(false)
  const [htmlFrameVersion, setHtmlFrameVersion] = useState(0)
  const contentRef = useRef<HTMLElement | null>(null)
  const shareCardContainerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const htmlResizeCleanupRef = useRef<(() => void) | null>(null)
  const activeDocumentIdRef = useRef<string | null>(null)
  const readPositionTimerRef = useRef<number | null>(null)
  const headingFrameRef = useRef<number | null>(null)
  const pendingReadPositionRef = useRef<{ top: number; progress: number; headingId?: string } | null>(null)
  const readerToolbarDragRef = useRef({
    active: false,
    moved: false,
    suppressClick: false,
    pointerId: null as number | null,
    startY: 0,
    lastRatio: settings.readerToolbarY ?? 0.9,
  })
  const renderStartedAtRef = useRef(0)
  const renderMetricsRevisionRef = useRef('')
  const handleOpenExternalLink = useCallback((url: string) => {
    void desktopPlatform.openExternalLink(url)
  }, [])
  const handleOpenDocumentLink = useCallback((href: string) => {
    if (classifyMarkdownLink(href) !== 'document') return

    const linkContext = {
      sourceUri: document.sourceUri,
      fileName: document.fileName,
      archiveRelativePath: document.archiveRelativePath,
      packageId: document.packageId,
      archiveStorageId: document.archiveStorageId,
    }
    const currentFilePath = getDocumentLinkBasePath(linkContext)
    const resolved = resolveDocumentLinkHref(href, currentFilePath, shouldConfineDocumentLinks(linkContext))
    if (!resolved) {
      onShowToast('无法打开该文档链接', 'warning')
      return
    }

    if (isSameDocumentPath(resolved.path, currentFilePath)) {
      if (resolved.hash) {
        setActiveHeadingId(resolved.hash)
        window.document.getElementById(resolved.hash)?.scrollIntoView({ block: 'start' })
      }
      return
    }

    if (!document.packageId && !document.archiveStorageId && isDesktopAbsolutePath(document.sourceUri)) {
      const desktopPath = resolveDesktopDocumentPath(document.sourceUri!, href)
      if (!desktopPath) {
        onShowToast('无法打开该文档链接', 'warning')
        return
      }
      onOpenDesktopDocument(desktopPath.path, { fromDocumentLink: true, headingId: desktopPath.hash })
      return
    }

    if (document.packageId || document.archiveStorageId) {
      const normalizedTarget = resolved.path.replace(/\\/g, '/').toLocaleLowerCase()
      const target = packageDocuments.find((item) =>
        (item.archiveRelativePath ?? item.fileName).replace(/\\/g, '/').toLocaleLowerCase() === normalizedTarget,
      )
      if (!target) {
        onShowToast('压缩包中找不到该文档', 'warning')
        return
      }
      onOpenPackageDocumentFromLink(target, { fromDocumentLink: true, headingId: resolved.hash })
      return
    }

    onShowToast('无法打开该文档链接', 'warning')
  }, [document, onOpenDesktopDocument, onOpenPackageDocumentFromLink, onShowToast, packageDocuments])
  const handleRenderPlanReady = useCallback((plan: { plainText: string; revision?: string }) => {
    setRenderPlainText(plan.plainText)
    const revision = plan.revision ?? `${document.id}:${plan.plainText.length}`
    if (renderMetricsRevisionRef.current === revision) return
    renderMetricsRevisionRef.current = revision
    finishPerformanceSpan('render-plan-complete', renderStartedAtRef.current, { characters: plan.plainText.length })
    window.requestAnimationFrame(() => {
      finishPerformanceSpan('first-paint', renderStartedAtRef.current, { characters: plan.plainText.length })
      window.setTimeout(() => finishPerformanceSpan('fully-interactive', renderStartedAtRef.current, { characters: plan.plainText.length }), 0)
    })
  }, [document.id])
  const handleRenderChange = useCallback(() => {
    setAnnotationRenderTick((value) => value + 1)
  }, [])

  useEffect(() => {
    setRenderPlainText('')
    setRichCopyRenderAll(false)
    renderStartedAtRef.current = startPerformanceSpan()
    renderMetricsRevisionRef.current = ''
  }, [document.id])

  useEffect(() => {
    if (document.fileType !== 'markdown' && desktopDirectoryMode === 'annotations') setDesktopDirectoryMode('chapters')
  }, [desktopDirectoryMode, document.fileType])

  useEffect(() => {
    setReaderToolbarY(settings.readerToolbarY)
  }, [settings.readerToolbarY])

  useEffect(() => {
    window.document.documentElement.dataset.readerToc = desktopTocOpen ? 'open' : 'closed'
    return () => {
      delete window.document.documentElement.dataset.readerToc
    }
  }, [desktopTocOpen])

  useEffect(() => {
    if (document.fileType !== 'markdown') {
      setAnnotations([])
      return
    }
    let cancelled = false
    void sha256Text(document.content).then(async (revision) => {
      if (cancelled) return
      setContentRevision(revision)
      if (document.contentRevision !== revision) onUpdate({ contentRevision: revision })
      const stored = await annotationRepository.listAnnotations(document.id)
      const progressiveText = contentRef.current?.classList.contains('progressive-markdown') ? renderPlainText : ''
      const rootText = progressiveText || (contentRef.current ? canonicalText(contentRef.current) : document.content)
      const restored = stored.map((item) => reanchorAnnotation(item, rootText, revision))
      if (cancelled) return
      setAnnotations(restored)
      await Promise.all(restored.filter((item, index) => item !== stored[index]).map((item) => annotationRepository.saveAnnotation(item)))
    })
    return () => { cancelled = true }
  }, [annotationRepository, document.content, document.contentRevision, document.fileType, document.id, onUpdate, renderPlainText])


  const allShareCardPages = useMemo(() => splitShareCardText(shareCardText ?? '', 620), [shareCardText])
  const shareCardPages = useMemo(
    () => allShareCardPages.map((text, sourceIndex) => ({ text, sourceIndex })).filter((item) => !removedShareCardPages.includes(item.sourceIndex)),
    [allShareCardPages, removedShareCardPages],
  )
  const validShareCardUrl = /^https?:\/\/[^\s]+$/i.test(shareCardSourceUrl.trim())

  useEffect(() => {
    if (!shareCardQrEnabled || !validShareCardUrl) {
      setShareCardQrDataUrl('')
      return
    }
    let cancelled = false
    void QRCode.toDataURL(shareCardSourceUrl.trim(), { width: 160, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setShareCardQrDataUrl(url) })
    return () => { cancelled = true }
  }, [shareCardQrEnabled, shareCardSourceUrl, validShareCardUrl])

  useEffect(() => {
    setRemovedShareCardPages([])
  }, [shareCardText])

  const exportShareCards = async () => {
    const pages = Array.from(shareCardContainerRef.current?.querySelectorAll<HTMLElement>('.share-card-page') ?? [])
    if (pages.length === 0) return
    setExporting(true)
    try {
      const { default: html2canvas } = await import('html2canvas-pro')
      const canvases = []
      for (const page of pages) canvases.push(await html2canvas(page, { scale: Math.min(2, window.devicePixelRatio || 1), useCORS: false, logging: false }))
      if (Capacitor.isNativePlatform()) {
        const files: string[] = []
        await FastViewerFiles.prepareShareCache({ expectedBytes: canvases.length * 4 * 1024 * 1024 })
        for (let index = 0; index < canvases.length; index += 1) {
          const bytes = await canvasToPngBytes(canvases[index])
          const path = `share/card-${crypto.randomUUID()}-${index + 1}.png`
          await Filesystem.writeFile({ path, data: bytesToBase64(bytes), directory: Directory.Cache, recursive: true })
          files.push((await Filesystem.getUri({ path, directory: Directory.Cache })).uri)
        }
        await Share.share({ title: `${document.fileName} 摘录`, files, dialogTitle: '分享阅读卡片' })
      } else {
        for (let index = 0; index < canvases.length; index += 1) {
          const link = window.document.createElement('a')
          link.href = canvases[index].toDataURL('image/png')
          link.download = `${document.fileName}-卡片-${index + 1}.png`
          link.click()
        }
      }
      onShowToast(`已生成 ${canvases.length} 张阅读卡片`, 'success')
      setShareCardText(null)
    } catch (error) {
      onShowToast(`卡片生成失败：${error instanceof Error ? error.message : '未知错误'}`, 'warning')
    } finally {
      setExporting(false)
    }
  }

  const openDesktopFileMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const menuWidth = 300
    const menuMaxHeight = Math.min(520, window.innerHeight - 24)
    setMenuPosition({
      x: clamp(event.clientX - menuWidth + 24, 12, window.innerWidth - menuWidth - 12),
      y: clamp(event.clientY + 10, 12, window.innerHeight - menuMaxHeight - 12),
    })
    setMenuOpen(true)
  }

  const allowScripts = document.fileType === 'html' && Boolean(document.allowHtmlScripts ?? document.trustedHtml)
  const allowForms = document.fileType === 'html' && Boolean(document.allowHtmlForms)
  const allowPopups = document.fileType === 'html' && Boolean(document.allowHtmlPopups)
  const allowExternalResources = document.fileType === 'html'
    && (allowExternalOnce || (settings.externalResourcePolicy === 'allowTrusted' && allowScripts))
  const htmlInfo = useMemo(
    () => {
      if (document.fileType !== 'html') return null
      try {
        const html = document.archiveResources
          ? rewriteRelativeResources(document.content, document.fileName, document.archiveRelativePath, document.archiveResources)
          : document.content
        return buildSafeHtmlDocument(html, { allowExternalResources, allowScripts, allowForms, allowPopups })
      } catch {
        return null
      }
    },
    [allowExternalResources, allowForms, allowPopups, allowScripts, document.archiveRelativePath, document.archiveResources, document.content, document.fileName, document.fileType],
  )

  useEffect(() => {
    const handleExternalLinkMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as { type?: string; url?: string } | null
      if (data?.type !== 'lightpage-external-link' || !data.url || !/^https?:\/\//i.test(data.url)) return
      if (window.confirm(`要打开外部链接吗？\n${data.url}`)) {
        window.open(data.url, '_blank', 'noopener,noreferrer')
      }
    }
    window.addEventListener('message', handleExternalLinkMessage)
    return () => window.removeEventListener('message', handleExternalLinkMessage)
  }, [])

  useEffect(() => () => htmlResizeCleanupRef.current?.(), [])

  const headings = useMemo(
    () => (document.fileType === 'html' ? htmlInfo?.headings ?? [] : extractMarkdownHeadings(document.content)),
    [document.content, document.fileType, htmlInfo],
  )

  const {
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
  } = useReaderAnnotations({
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
  })
  const {
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    debouncedQuery,
    setDebouncedQuery,
    searchIndex,
    setSearchIndex,
    searchCount,
  } = useReaderSearch({
    fileType: document.fileType,
    contentLength: document.content.length,
    readerMode,
    htmlFrameVersion,
    htmlSrcDoc: htmlInfo?.srcDoc,
    contentRef,
    iframeRef,
  })

  useEffect(() => {
    if (activeDocumentIdRef.current === document.id) return
    activeDocumentIdRef.current = document.id

    setQuery('')
    setDebouncedQuery('')
    setSearchOpen(false)
    setSearchIndex(0)
    setTocQuery('')
    setTocOpen(false)
    setDesktopTocOpen(true)
    setMenuOpen(false)
    const pendingHeadingId = linkNavigationHeadingId
    setActiveHeadingId(pendingHeadingId ?? document.lastReadHeadingId ?? '')
    setReaderMode(document.fileSize >= FILE_SIZE_DANGER ? 'source' : 'rendered')
    setRenderFailed(false)
    setAllowExternalOnce(false)
    setReaderToolsOpen(false)
    setEncodingOpen(false)
    setHtmlPermissionsOpen(false)
    setImageExportOpen(false)
    window.setTimeout(() => {
      const scroller = scrollRef.current
      if (!scroller) return
      const headingId = pendingHeadingId ?? document.lastReadHeadingId
      if (headingId) {
        let target: HTMLElement | null | undefined
        try {
          target = document.fileType === 'html'
            ? iframeRef.current?.contentDocument?.getElementById(headingId)
            : window.document.getElementById(headingId)
        } catch {
          target = null
        }
        if (target) {
          target.scrollIntoView({ block: 'start' })
          return
        }
      }
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const restoredTop = document.lastReadProgress && document.lastReadProgress > 0
        ? maxScroll * document.lastReadProgress
        : document.lastReadPosition
      scroller.scrollTo({ top: restoredTop })
    }, 0)
    if (pendingHeadingId) onConsumeLinkNavigationHeading()
  }, [document.fileSize, document.fileType, document.id, document.lastReadHeadingId, document.lastReadPosition, document.lastReadProgress, linkNavigationHeadingId, onConsumeLinkNavigationHeading, setDebouncedQuery, setQuery, setSearchIndex, setSearchOpen])


  const flushReadPosition = useCallback(() => {
    if (readPositionTimerRef.current !== null) {
      window.clearTimeout(readPositionTimerRef.current)
      readPositionTimerRef.current = null
    }
    const pending = pendingReadPositionRef.current
    if (!pending) return
    pendingReadPositionRef.current = null
    if (Math.abs(pending.top - document.lastReadPosition) > 24
      || Math.abs(pending.progress - (document.lastReadProgress ?? 0)) > 0.002) {
      onUpdate({
        lastReadPosition: pending.top,
        lastReadProgress: pending.progress,
        lastReadHeadingId: pending.headingId || document.lastReadHeadingId,
      })
    }
  }, [document.lastReadHeadingId, document.lastReadPosition, document.lastReadProgress, onUpdate])

  const scheduleReadPositionSave = () => {
    const scroller = scrollRef.current
    if (!scroller) return
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
    pendingReadPositionRef.current = {
      top: scroller.scrollTop,
      progress: clamp(scroller.scrollTop / maxScroll, 0, 1),
      headingId: activeHeadingId || undefined,
    }
    if (headingFrameRef.current === null) {
      headingFrameRef.current = window.requestAnimationFrame(() => {
        headingFrameRef.current = null
        const nextHeading = findActiveHeading(document.fileType, headings, iframeRef.current)
        if (nextHeading) setActiveHeadingId(nextHeading)
      })
    }
    if (readPositionTimerRef.current !== null) return
    readPositionTimerRef.current = window.setTimeout(flushReadPosition, 800)
  }

  useEffect(() => {
    const handleVisibility = () => {
      if (window.document.visibilityState === 'hidden') flushReadPosition()
    }
    window.document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.document.removeEventListener('visibilitychange', handleVisibility)
      if (headingFrameRef.current !== null) window.cancelAnimationFrame(headingFrameRef.current)
      flushReadPosition()
    }
  }, [flushReadPosition])

  const visibleHeadings = useMemo(() => {
    const queryText = tocQuery.trim().toLocaleLowerCase()
    return headings.filter((heading) => {
      if (!tocExpanded && heading.level > 2) return false
      return !queryText || heading.text.toLocaleLowerCase().includes(queryText)
    })
  }, [headings, tocExpanded, tocQuery])

  const sortedDirectoryFiles = useMemo(
    () => sortDirectoryDocuments(directoryListing?.files ?? [], directorySortMode),
    [directoryListing?.files, directorySortMode],
  )

  const changeFontSize = (delta: number) => {
    const next = clamp(settings.fontSizeLevel + delta, 0, 4)
    onSetSettings({ ...settings, fontSizeLevel: next })
  }

  const toggleTheme = () => {
    onSetSettings({
      ...settings,
      themeMode: nextThemePreference(settings.themeMode),
    })
  }

  useEffect(() => {
    const handleCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail
      if (command === 'find') setSearchOpen(true)
      else if (command === 'toc') setDesktopTocOpen((open) => !open)
      else if (command === 'export') setMenuOpen(true)
      else if (command === 'font-increase') changeFontSize(1)
      else if (command === 'font-decrease') changeFontSize(-1)
      else if (command === 'font-reset') onSetSettings({ ...settings, fontSizeLevel: 2 })
      else if (command === 'bookmark') void addBookmark()
      else if (command === 'highlight') void highlightCurrentSelection()
    }
    window.addEventListener('lightpage-reader-command', handleCommand)
    return () => window.removeEventListener('lightpage-reader-command', handleCommand)
  // Reader commands intentionally bind the current settings snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addBookmark, highlightCurrentSelection, settings])

  const toggleFavorite = () => {
    onUpdate({ isFavorite: !document.isFavorite })
    if (document.packageId) {
      void annotationRepository.listPackageEntries(document.packageId)
        .then((entries) => annotationRepository.savePackageEntries(entries.map((entry) => entry.documentId === document.id ? { ...entry, isFavorite: !document.isFavorite } : entry)))
        .catch(() => undefined)
    }
    onShowToast(document.isFavorite ? '已取消收藏' : '已收藏', 'success')
  }

  const saveToLibrary = () => {
    onUpdate({ inLibrary: true })
    onShowToast('已保存到文件库', 'success')
  }

  const copyText = async () => {
    const source = readerMode === 'source'
      ? document.content
      : document.fileType === 'html'
        ? htmlInfo?.plainText ?? document.content
        : document.content
    try {
      await navigator.clipboard.writeText(source)
      onShowToast('已复制全文', 'success')
    } catch {
      try {
        const ta = window.document.createElement('textarea')
        ta.value = source
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        window.document.body.appendChild(ta)
        ta.select()
        window.document.execCommand('copy')
        window.document.body.removeChild(ta)
        onShowToast('已复制全文', 'success')
      } catch {
        onShowToast('复制失败，请检查系统权限', 'warning')
      }
    }
  }

  const copyRichText = async () => {
    if (document.fileType !== 'markdown' || readerMode !== 'rendered' || renderFailed) return
    setRichCopyRenderAll(true)
    let fallbackText = renderPlainText || document.content
    try {
      const root = await waitForRichTextRender(() => contentRef.current)
      const payload = await buildRichTextPayload(root, document.fileName)
      fallbackText = payload.text || fallbackText
      if (Capacitor.isNativePlatform()) {
        await FastViewerFiles.copyRichText({ label: document.fileName, ...payload })
      } else {
        await writeRichTextToClipboard(payload)
      }
      onShowToast('已复制富文本', 'success')
    } catch {
      const copied = await writePlainTextToClipboard(fallbackText)
      onShowToast(copied ? '富文本复制失败，已复制纯文本' : '复制失败，请检查系统剪贴板权限', 'warning')
    } finally {
      setRichCopyRenderAll(false)
    }
  }

  const nextSearchResult = (delta: number) => {
    if (searchCount === 0) return
    setSearchIndex((current) => (current + delta + searchCount) % searchCount)
  }

  const closeTopReaderLayer = useCallback(() => {
    if (shareCardText !== null) {
      setShareCardText(null)
      return true
    }
    if (selectionAction) {
      setSelectionAction(null)
      window.getSelection()?.removeAllRanges()
      return true
    }
    if (imageExportOpen) {
      setImageExportOpen(false)
      return true
    }
    if (encodingOpen) {
      setEncodingOpen(false)
      return true
    }
    if (htmlPermissionsOpen) {
      setHtmlPermissionsOpen(false)
      return true
    }
    if (menuOpen) {
      setMenuOpen(false)
      return true
    }
    if (tocOpen) {
      setTocOpen(false)
      return true
    }
    if (searchOpen) {
      setSearchOpen(false)
      return true
    }
    if (readerToolsOpen) {
      setReaderToolsOpen(false)
      return true
    }
    if (packageOpen) {
      setPackageOpen(false)
      return true
    }
    if (annotationsOpen) {
      setAnnotationsOpen(false)
      return true
    }

    return false
  }, [annotationsOpen, encodingOpen, htmlPermissionsOpen, imageExportOpen, menuOpen, packageOpen, readerToolsOpen, searchOpen, selectionAction, setSearchOpen, shareCardText, tocOpen])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined

    let backButtonHandle: PluginListenerHandle | null = null
    let disposed = false
    void CapacitorApp.addListener('backButton', () => {
      if (closeTopReaderLayer()) return
      onBack()
    }).then((handle) => {
      if (disposed) {
        void handle.remove()
        return
      }
      backButtonHandle = handle
    })

    return () => {
      disposed = true
      void backButtonHandle?.remove()
    }
  }, [closeTopReaderLayer, onBack])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined
    let handle: PluginListenerHandle | null = null
    let disposed = false
    void FastViewerFiles.setVolumePageEnabled({ enabled: settings.volumePageKeys })
    if (settings.volumePageKeys) {
      void FastViewerFiles.addListener('volumePage', (result) => {
        if (!('direction' in result)) return
        const viewport = scrollRef.current
        if (!viewport) return
        viewport.scrollBy({
          top: (result.direction === 'next' ? 1 : -1) * viewport.clientHeight * 0.86,
          behavior: 'smooth',
        })
      }).then((listener) => {
        if (disposed) void listener.remove()
        else handle = listener
      })
    }
    return () => {
      disposed = true
      void handle?.remove()
      void FastViewerFiles.setVolumePageEnabled({ enabled: false })
    }
  }, [settings.volumePageKeys])

  useEffect(() => {
    const collapseToolsForSelection = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.anchorNode || !contentRef.current?.contains(selection.anchorNode)) return
      setReaderToolsOpen(false)
    }
    window.document.addEventListener('selectionchange', collapseToolsForSelection)
    return () => window.document.removeEventListener('selectionchange', collapseToolsForSelection)
  }, [document.id])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined
    const selectionActionsEnabled = document.fileType === 'markdown' && readerMode === 'rendered' && !searchOpen
    void FastViewerFiles.setSelectionActionsEnabled({ enabled: selectionActionsEnabled })

    const handleNativeSelectionActionEvent = (event: Event) => {
      const action = (event as CustomEvent<{ action?: NativeSelectionAction }>).detail?.action
      if (action !== 'highlight' && action !== 'note' && action !== 'card') return
      handleNativeSelectionAction(action)
    }
    window.addEventListener('lightpage:native-selection-action', handleNativeSelectionActionEvent)
    return () => {
      window.removeEventListener('lightpage:native-selection-action', handleNativeSelectionActionEvent)
      void FastViewerFiles.setSelectionActionsEnabled({ enabled: false })
    }
  }, [document.fileType, handleNativeSelectionAction, readerMode, searchOpen])

  const toggleEdgeDirectory = () => {
    setReaderToolsOpen(false)
    setSelectionAction(null)
    setMenuOpen(false)
    if (window.innerWidth >= 840) {
      setTocOpen(false)
      setDesktopTocOpen((open) => !open)
      return
    }
    setTocOpen((open) => !open)
  }

  const handleReaderToolbarPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    readerToolbarDragRef.current = {
      active: true,
      moved: false,
      suppressClick: false,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastRatio: readerToolbarY ?? 0.9,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针仍会通过普通 pointer 事件完成点击。
    }
  }

  const handleReaderToolbarPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = readerToolbarDragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 6) return
    event.stopPropagation()
    drag.moved = true
    drag.suppressClick = true
    const viewportHeight = Math.max(320, window.visualViewport?.height ?? window.innerHeight)
    const menuHeight = Math.min(340, Math.max(160, viewportHeight - 180))
    const minRatio = clamp((menuHeight + 86) / viewportHeight, 0.46, 0.82)
    const minBottom = isDesktop ? 18 : 82
    const maxRatio = 1 - minBottom / viewportHeight
    const ratio = clamp((event.clientY + 26) / viewportHeight, minRatio, maxRatio)
    drag.lastRatio = ratio
    setReaderToolbarY(ratio)
  }

  const finishReaderToolbarDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = readerToolbarDragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return
    event.stopPropagation()
    drag.active = false
    drag.pointerId = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // 指针已释放。
    }
    if (drag.moved) {
      onSetSettings({ ...settings, readerToolbarY: drag.lastRatio })
    }
  }

  const resetReaderToolbarPosition = () => {
    readerToolbarDragRef.current.suppressClick = true
    setReaderToolbarY(null)
    onSetSettings({ ...settings, readerToolbarY: null })
    onShowToast('阅读工具位置已恢复', 'success')
  }

  const isReaderMarginTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false
    return target === scrollRef.current
      || target.classList.contains('reader-document-pane')
      || target.classList.contains('reader-content')
  }

  const handleReaderTap = (event: React.MouseEvent<HTMLElement>) => {
    if (!settings.immersiveTap || !isReaderMarginTarget(event.target)) return
    if (!window.getSelection()?.isCollapsed) return
    setImmersive((value) => !value)
  }

  const handleReaderDoubleTap = (event: React.MouseEvent<HTMLElement>) => {
    if (!settings.doubleTapReset || !isReaderMarginTarget(event.target)) return
    onSetSettings({
      ...settings,
      fontSizeLevel: 2,
      lineHeightLevel: 1,
      contentWidthLevel: 1,
      codeSizeLevel: 1,
    })
    onShowToast('已恢复默认阅读排版', 'success')
  }

  const switchEncoding = (encoding: EncodingLabel) => {
    if (!document.rawBase64) {
      onShowToast('文件过大，无法切换编码，请重新打开文件', 'warning')
      setEncodingOpen(false)
      return
    }
    try {
      const bytes = base64ToBytes(document.rawBase64)
      const content = decodeWithEncoding(bytes, encoding)
      onUpdate({ content, encoding: encoding.toUpperCase() })
      setRenderFailed(false)
      onShowToast(`已切换为 ${encoding.toUpperCase()}`, 'success')
    } catch {
      onShowToast('编码切换失败', 'warning')
    }
    setEncodingOpen(false)
  }

  const { exporting, setExporting, shareOriginalFile, exportPdf, shareAsImage } = useReaderExport({
    doc: document,
    isDesktop,
    onShowToast,
    setMenuOpen,
    contentRef,
    iframeRef,
    scrollRef,
    htmlInfo,
    resolvedTheme,
    allowScripts,
    allowExternalResources,
  })
  const [activeBackgroundTasks, setActiveBackgroundTasks] = useState<BackgroundTask[]>([])

  useEffect(() => backgroundTasks.subscribe((tasks) => {
    setActiveBackgroundTasks(tasks.filter((task) => ['queued', 'running'].includes(task.status)))
  }), [])

  const authorizeHtmlResources = async () => {
    try {
      const result = await FastViewerFiles.selectResourceDirectory()
      const resources = Object.fromEntries(
        Object.entries(result.resources).map(([key, resource]) => [key, Capacitor.convertFileSrc(resource.path)]),
      )
      if (document.resourceStorageId) {
        void FastViewerFiles.releaseArchive({ storageId: document.resourceStorageId }).catch(() => undefined)
      }
      onUpdate({
        archiveResources: resources,
        resourceStorageId: result.storageId,
      })
      onShowToast(`已授权并缓存 ${result.count} 个同目录资源`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : '目录授权失败'
      if (!/cancel/i.test(message)) onShowToast(message, 'warning')
    }
  }

  const statusText =
    document.lastReadPosition > 0 ? '已恢复阅读位置' : '从顶部开始'

  const handleHtmlFrameLoad = () => {
    const iframe = iframeRef.current
    if (!iframe) return
    htmlResizeCleanupRef.current?.()

    // Script-enabled HTML intentionally has an isolated origin, so its DOM is
    // unavailable here. Size the outer iframe before attempting DOM access; this
    // keeps the document viewport flush with the mobile navigation bar instead
    // of falling back to the old 68-78vh box and leaving a large blank strip.
    const resizeToVisibleBottom = () => {
      const frameTop = Math.max(0, iframe.getBoundingClientRect().top)
      const viewportBottom = window.document.documentElement.clientHeight
      const navigationTop = window.document.querySelector<HTMLElement>('.bottom-nav')?.getBoundingClientRect().top
      const isDesktopRuntime = window.document.documentElement.dataset.runtime === 'desktop'
      const visibleBottom = !isDesktopRuntime && navigationTop && navigationTop > frameTop
        ? Math.min(viewportBottom, navigationTop)
        : viewportBottom
      return Math.max(240, visibleBottom - frameTop)
    }

    let frameDocument: Document | null = null
    try {
      frameDocument = iframe?.contentDocument ?? null
    } catch {
      // Script mode intentionally uses an isolated origin, so parent DOM access is unavailable.
    }
    if (!frameDocument) {
      const resizeIsolatedFrame = () => {
        iframe.style.height = `${resizeToVisibleBottom()}px`
      }
      resizeIsolatedFrame()
      window.addEventListener('resize', resizeIsolatedFrame)
      window.visualViewport?.addEventListener('resize', resizeIsolatedFrame)
      htmlResizeCleanupRef.current = () => {
        window.removeEventListener('resize', resizeIsolatedFrame)
        window.visualViewport?.removeEventListener('resize', resizeIsolatedFrame)
      }
      return
    }

    iframe.style.height = ''

    let resizeFrameId: number | null = null
    const resizeFrameNow = () => {
      resizeFrameId = null
      const availableHeight = resizeToVisibleBottom()
      const { height: contentHeight } = measureFrameDocument(frameDocument, iframe)
      const nextHeight = Math.max(contentHeight, availableHeight)
      if (Math.abs(iframe.getBoundingClientRect().height - nextHeight) > 1) {
        iframe.style.height = `${nextHeight}px`
      }
    }
    const scheduleResizeFrame = () => {
      if (resizeFrameId !== null) return
      resizeFrameId = window.requestAnimationFrame(resizeFrameNow)
    }

    scheduleResizeFrame()
    window.setTimeout(scheduleResizeFrame, 120)
    window.setTimeout(scheduleResizeFrame, 600)

    const mutationObserver = new MutationObserver(scheduleResizeFrame)
    mutationObserver.observe(frameDocument.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    })
    frameDocument.addEventListener('load', scheduleResizeFrame, true)
    const handleViewportResize = () => {
      iframe.style.height = ''
      scheduleResizeFrame()
    }
    window.addEventListener('resize', handleViewportResize)

    const disconnectFrameObservers = () => {
      mutationObserver.disconnect()
      frameDocument.removeEventListener('load', scheduleResizeFrame, true)
      window.removeEventListener('resize', handleViewportResize)
      if (resizeFrameId !== null) window.cancelAnimationFrame(resizeFrameId)
    }
    htmlResizeCleanupRef.current = disconnectFrameObservers
    iframe.addEventListener('load', disconnectFrameObservers, { once: true })

    if (!allowScripts) {
      frameDocument.querySelectorAll('a[href]').forEach((anchor) => {
        anchor.addEventListener('click', (event) => {
          const element = event.currentTarget as HTMLAnchorElement
          const href = element.dataset.externalHref
          if (!href) return

          event.preventDefault()
          if (window.confirm(`要打开外部链接吗？\n${href}`)) {
            void desktopPlatform.openExternalLink(href)
          }
        })
      })
    }

    setHtmlFrameVersion((version) => version + 1)
  }

  const jumpToHeading = (heading: HeadingItem, closeMobileDirectory: boolean) => {
    setActiveHeadingId(heading.id)
    onUpdate({ lastReadHeadingId: heading.id })
    const scroll = () => {
      try {
        if (document.fileType === 'html') {
          if (allowScripts) {
            iframeRef.current?.contentWindow?.postMessage({ type: 'lightpage-scroll-to-heading', id: heading.id }, '*')
          } else {
            iframeRef.current?.contentDocument?.getElementById(heading.id)?.scrollIntoView({ block: 'start' })
          }
          return
        }
        const target = window.document.getElementById(heading.id)
        const scroller = scrollRef.current
        if (!target || !scroller) return
        const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        scroller.scrollTo({ top, behavior: 'auto' })
      } catch {
        onShowToast('暂时无法定位到该章节', 'warning')
      }
    }
    if (closeMobileDirectory) setTocOpen(false)
    scroll()
    window.setTimeout(scroll, 60)
  }

  const renderTableOfContents = (closeMobileDirectory: boolean) => (
    <>
      {headings.length > 0 && (
        <div className="toc-tools">
          <input
            value={tocQuery}
            placeholder="搜索目录"
            aria-label="搜索目录"
            onChange={(event) => setTocQuery(event.target.value)}
          />
          <button type="button" onClick={() => setTocExpanded((expanded) => !expanded)}>
            {tocExpanded ? '折叠' : '展开'}
          </button>
        </div>
      )}
      {headings.length === 0 ? (
        <p className="sheet-empty">当前文档没有标题。</p>
      ) : (
        <div className="toc-list">
          {visibleHeadings.map((heading) => {
            // This callback runs only after user input, when reading the content refs is valid.
            // eslint-disable-next-line react-hooks/refs
            const handleHeadingClick = () => jumpToHeading(heading, closeMobileDirectory)
            return (
              <button
                key={heading.id}
                className={`toc-item level-${heading.level}${activeHeadingId === heading.id ? ' active' : ''}`}
                type="button"
                data-heading-id={heading.id}
                onClick={handleHeadingClick}
              >
                {heading.text}
              </button>
            )
          })}
        </div>
      )}
    </>
  )

  const renderCurrentDirectory = () => {
    if (!directoryListing) {
      return <p className="sheet-empty">当前文件没有可访问的本地目录。</p>
    }
    if (sortedDirectoryFiles.length === 0) {
      return <p className="sheet-empty">当前目录没有 Markdown 或 HTML 文档。</p>
    }
    const activePath = document.sourceUri?.replace(/\\/g, '/').toLocaleLowerCase()
    return (
      <div className="directory-document-list" aria-label="当前目录文档">
        {sortedDirectoryFiles.map((file) => {
          const selected = file.path.replace(/\\/g, '/').toLocaleLowerCase() === activePath
          return (
            <button
              key={file.path}
              className={`directory-document${selected ? ' active' : ''}`}
              type="button"
              disabled={selected}
              title={file.path}
              onClick={() => onOpenDirectoryDocument(file.path)}
            >
              {file.fileName.toLocaleLowerCase().endsWith('.html') || file.fileName.toLocaleLowerCase().endsWith('.htm')
                ? <FileCode2 size={16} />
                : <FileText size={16} />}
              <span><strong>{file.fileName}</strong><small>{directoryFileDetails(file)}</small></span>
            </button>
          )
        })}
      </div>
    )
  }

  const fileMenu = (
    <FileMenu
      document={document}
      readerMode={readerMode}
      isDesktop={isDesktop}
      annotationsCount={annotations.length}
      packageCount={packageDocuments.length}
      exporting={exporting}
      renderFailed={renderFailed}
      onReload={onReload}
      onClose={() => setMenuOpen(false)}
      onSaveToLibrary={saveToLibrary}
      onToggleFavorite={toggleFavorite}
      onToggleReaderMode={() => setReaderMode(readerMode === 'source' ? 'rendered' : 'source')}
      onCopyText={() => { void copyText() }}
      onCopyRichText={() => { void copyRichText() }}
      onAddBookmark={() => { void addBookmark() }}
      onOpenAnnotations={() => {
        if (isDesktop) {
          setDesktopTocOpen(true)
          setDesktopDirectoryMode('annotations')
        } else setAnnotationsOpen(true)
      }}
      onExportAnnotations={() => { void exportAnnotations() }}
      onOpenPackage={() => setPackageOpen(true)}
      onOpenHtmlPermissions={() => setHtmlPermissionsOpen(true)}
      onOpenEncoding={() => setEncodingOpen(true)}
      onExportPdf={() => { void exportPdf() }}
      onOpenImageExport={() => setImageExportOpen(true)}
      onShareOriginal={() => { void shareOriginalFile() }}
    />
  )

  const visibleAnnotations = [...annotations]
    .filter((item) => (
      (annotationKindFilter === 'all' || item.kind === annotationKindFilter)
      && (annotationStatusFilter === 'all' || item.status === annotationStatusFilter)
    ))
    .sort((left, right) => left.anchor.start - right.anchor.start)

  const renderAnnotationBrowser = () => (
    <>
      <div className="annotation-filters" role="toolbar" aria-label="批注筛选">
        {([['all', '全部'], ['highlight', '高亮'], ['note', '批注'], ['bookmark', '书签']] as const).map(([value, label]) => (
          <button key={value} type="button" className={annotationKindFilter === value ? 'active' : ''} onClick={() => setAnnotationKindFilter(value)}>{label}</button>
        ))}
        {([['active', '有效'], ['orphaned', '待关联']] as const).map(([value, label]) => (
          <button key={value} type="button" className={annotationStatusFilter === value ? 'active' : ''} onClick={() => setAnnotationStatusFilter((current) => current === value ? 'all' : value)}>{label}</button>
        ))}
      </div>
      {visibleAnnotations.length === 0 ? (
        <p className="sheet-description">选择文字后可高亮或批注，也可以添加章节书签。</p>
      ) : (
        <div className="annotation-list">
          {visibleAnnotations.map((item) => (
            <article className={`annotation-item color-${item.color ?? 'yellow'}${item.status === 'orphaned' ? ' orphaned' : ''}`} key={item.id}>
              <button type="button" className="annotation-main" data-heading-id={item.anchor.headingId} onClick={() => jumpToAnnotation(item)}>
                <strong>{item.kind === 'bookmark' ? '书签' : item.kind === 'note' ? '批注' : '高亮'}{item.status === 'orphaned' ? ' · 待重新关联' : ''}</strong>
                <span>{item.anchor.exact || item.anchor.headingId || '当前位置'}</span>
                {item.note && <small>{item.note}</small>}
              </button>
              {item.anchor.exact && <button type="button" className="annotation-card" onClick={() => setShareCardText(item.anchor.exact)} aria-label="生成阅读卡片"><Share2 size={16} /></button>}
              {item.kind === 'note' && <button type="button" className="annotation-card" onClick={() => { void editAnnotation(item) }} aria-label="编辑批注"><MessageSquare size={16} /></button>}
              <button type="button" className="annotation-delete" onClick={() => { void removeAnnotation(item.id) }} aria-label="删除批注"><X size={16} /></button>
            </article>
          ))}
        </div>
      )}
      {annotations.length > 0 && <button className="primary-action compact" type="button" onClick={() => { void exportAnnotations() }}>{isDesktop ? '导出批注摘要' : '分享批注摘要'}</button>}
    </>
  )

  const handleDesktopTocWheel = (event: React.WheelEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const scroller = event.currentTarget.querySelector<HTMLElement>('.desktop-toc-content')
    if (scroller) scroller.scrollTop += event.deltaY
  }

  return (
    <section
      className={`page page-reader document-${document.fileType}${desktopTocOpen ? '' : ' desktop-toc-collapsed'}${immersive ? ' immersive' : ''}${settings.rightEdgeToc && !isDesktop ? ' edge-toc-enabled' : ''} font-level-${settings.fontSizeLevel} line-level-${settings.lineHeightLevel} width-level-${settings.contentWidthLevel} code-level-${settings.codeSizeLevel}`}
      aria-label="文件阅读页"
      ref={scrollRef}
      onScroll={scheduleReadPositionSave}
      onPointerUp={() => window.setTimeout(captureReaderSelection)}
      onClick={handleReaderTap}
      onDoubleClick={handleReaderDoubleTap}
    >
      {settings.rightEdgeToc && !isDesktop && (
        <button
          type="button"
          className={`toc-edge-trigger${(window.innerWidth >= 840 ? desktopTocOpen : tocOpen) ? ' active' : ''}`}
          aria-label={(window.innerWidth >= 840 ? desktopTocOpen : tocOpen) ? '隐藏目录' : '显示目录'}
          aria-expanded={window.innerWidth >= 840 ? desktopTocOpen : tocOpen}
          title={(window.innerWidth >= 840 ? desktopTocOpen : tocOpen) ? '隐藏目录' : '显示目录'}
          onClick={(event) => {
            event.stopPropagation()
            toggleEdgeDirectory()
          }}
        />
      )}
      <header className="reader-header">
        <button className="icon-button" type="button" onClick={onBack} aria-label="返回">
          <ChevronLeft size={22} />
        </button>
        <div className="reader-title">
          <h1>{document.fileName}</h1>
          <p>来自{document.sourceType} · {document.fileExtension.toUpperCase()}</p>
        </div>
        <div className="reader-actions" aria-label="阅读操作">
          <button className="icon-button mobile-only" type="button" onClick={() => setSearchOpen(true)} aria-label="搜索">
            <Search size={19} />
          </button>
          <button className="icon-button mobile-only" type="button" onClick={() => setTocOpen(true)} aria-label="目录">
            <ListTree size={19} />
          </button>
          <button className="icon-button mobile-only" type="button" onClick={() => setMenuOpen(true)} aria-label="更多">
            <Menu size={19} />
          </button>
          <button
            className={`desktop-toolbar-button desktop-only${searchOpen ? ' active' : ''}`}
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
            aria-expanded={searchOpen}
          >
            <Search size={17} />
            <span>查找</span>
          </button>
          <button
            className={`desktop-toolbar-button desktop-only${desktopTocOpen ? ' active' : ''}`}
            type="button"
            onClick={() => setDesktopTocOpen((open) => !open)}
            aria-expanded={desktopTocOpen}
          >
            <ListTree size={17} />
            <span>目录</span>
          </button>
          <button
            className={`desktop-toolbar-button desktop-only${menuOpen ? ' active' : ''}`}
            type="button"
            onClick={openDesktopFileMenu}
            aria-expanded={menuOpen}
          >
            <Menu size={17} />
            <span>文件操作</span>
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="search-panel" role="search" onPointerDown={(event) => event.stopPropagation()}>
          <Search size={17} />
          <input
            value={query}
            autoFocus
            placeholder="搜索当前文档"
            onChange={(event) => {
              setQuery(event.target.value)
              setSearchIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              nextSearchResult(event.shiftKey ? -1 : 1)
            }}
          />
          <span className="search-count">
            {query ? `${searchCount ? searchIndex + 1 : 0}/${searchCount}` : '0/0'}
          </span>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              nextSearchResult(-1)
            }}
          >
            上
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              nextSearchResult(1)
            }}
          >
            下
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setSearchOpen(false)
            }}
            aria-label="关闭搜索"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <aside
        className="desktop-toc desktop-only"
        aria-label="文档导航"
        onWheel={handleDesktopTocWheel}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onPointerCancel={(event) => event.stopPropagation()}
      >
        <header className="desktop-toc-header">
          <div className="desktop-directory-tabs" role="tablist" aria-label="目录内容">
            <button
              type="button"
              role="tab"
              aria-selected={desktopDirectoryMode === 'chapters'}
              className={desktopDirectoryMode === 'chapters' ? 'active' : ''}
              onClick={() => setDesktopDirectoryMode('chapters')}
            >
              章节
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={desktopDirectoryMode === 'files'}
              className={desktopDirectoryMode === 'files' ? 'active' : ''}
              onClick={() => setDesktopDirectoryMode('files')}
            >
              当前目录
            </button>
            {document.fileType === 'markdown' && (
              <button
                type="button"
                role="tab"
                aria-selected={desktopDirectoryMode === 'annotations'}
                className={desktopDirectoryMode === 'annotations' ? 'active' : ''}
                onClick={() => setDesktopDirectoryMode('annotations')}
              >
                批注
              </button>
            )}
          </div>
          <button className="icon-button" type="button" onClick={() => setDesktopTocOpen(false)} aria-label="收起目录">
            <X size={17} />
          </button>
        </header>
        {directoryListing && desktopDirectoryMode === 'files' && (
          <div className="current-directory-toolbar">
            <div className="current-directory-path">
              <span title={displayDirectoryPath(directoryListing.path)}>{displayDirectoryPath(directoryListing.path)}</span>
              <button
                type="button"
                className={directoryPinned ? 'active' : ''}
                onClick={onToggleDirectoryPin}
                title={`${directoryPinned ? '取消固定' : '固定到左侧'}：${displayDirectoryPath(directoryListing.path)}`}
              >
                {directoryPinned ? <PinOff size={14} /> : <Pin size={14} />}
                {directoryPinned ? '取消固定' : '固定到左侧'}
              </button>
            </div>
            <DirectorySortControl value={directorySortMode} onChange={onDirectorySortModeChange} />
          </div>
        )}
        <div className="desktop-toc-content" role="region" aria-label={desktopDirectoryMode === 'chapters' ? '可滚动章节列表' : desktopDirectoryMode === 'annotations' ? '批注列表' : '当前目录文档列表'} tabIndex={0}>
          {desktopDirectoryMode === 'annotations' ? renderAnnotationBrowser() : desktopDirectoryMode === 'chapters' ? renderTableOfContents(false) : renderCurrentDirectory()}
        </div>
      </aside>

      <div className="reader-document-pane">

      {activeBackgroundTasks.map((task) => (
        <div className="background-task-banner" role="status" key={task.id}>
          <span>{task.message ?? '后台任务'} · {Math.round(task.progress * 100)}%</span>
          <button type="button" onClick={() => backgroundTasks.cancel(task.id)}>取消</button>
        </div>
      ))}

      <div className="reader-status">
        <span>{statusText}</span>
        <button className="encoding-badge" type="button" onClick={() => setEncodingOpen(true)}>
          {document.encoding}
        </button>
        {document.fileType === 'html' && (
          <button
            className={`trust-badge${allowScripts ? ' trusted' : ''}`}
            type="button"
            onClick={() => setHtmlPermissionsOpen(true)}
            aria-label="打开 HTML 权限设置"
            title="HTML 权限"
          >
            <ShieldCheck size={14} />
            <span>{allowScripts || allowForms || allowPopups ? '自定义权限' : '严格沙盒'}</span>
          </button>
        )}
        <span>本地处理</span>
      </div>

      {document.fileType === 'html' && htmlInfo && htmlInfo.externalResources.length > 0 && (
        <div className={`external-resource-banner${allowExternalResources ? ' allowed' : ''}`}>
          <ShieldCheck size={16} />
          <span>
            {allowExternalResources
              ? `本次已允许 ${htmlInfo.externalResources.length} 个外部资源`
              : `已阻止 ${htmlInfo.externalResources.length} 个外部资源`}
          </span>
          <button
            type="button"
            onClick={() => setAllowExternalOnce((allowed) => !allowed)}
          >
            {allowExternalResources ? '恢复阻止' : '仅本次允许'}
          </button>
        </div>
      )}

      {readerMode === 'source' || renderFailed ? (
        <div>
          {renderFailed && (
            <div className="render-fallback-notice">
              <AlertCircle size={16} />
              <span>渲染异常，已切换{document.fileType === 'html' ? '源码' : '纯文本'}视图</span>
              <button type="button" onClick={() => { setRenderFailed(false); setReaderMode('rendered') }}>重试</button>
            </div>
          )}
          <pre className="source-view">{document.content}</pre>
        </div>
      ) : document.fileType === 'html' && htmlInfo ? (
        <HtmlReader
          iframeRef={iframeRef}
          info={htmlInfo}
          scriptsEnabled={allowScripts}
          formsEnabled={allowForms}
          onFrameLoad={handleHtmlFrameLoad}
        />
      ) : document.fileType === 'html' && !htmlInfo ? (
        <div>
          <div className="render-fallback-notice">
            <AlertCircle size={16} />
            <span>HTML 解析异常，已切换源码视图</span>
          </div>
          <pre className="source-view">{document.content}</pre>
        </div>
      ) : document.fileType === 'markdown' ? (
        <RenderErrorBoundary
          key={`${document.id}:${markdownContentRevision}:${markdownRenderAttempt}`}
          fallback={
            <div>
              <div className="render-fallback-notice">
                <AlertCircle size={16} />
                <span>渲染异常，已切换纯文本视图</span>
                <button type="button" onClick={() => { setRenderFailed(false); setMarkdownRenderAttempt((value) => value + 1) }}>重试</button>
              </div>
              <pre className="source-view">{document.content}</pre>
            </div>
          }
          onError={(error, info) => {
            console.error('Markdown render failed', error, info.componentStack)
            if (markdownRenderAttempt === 0) {
              window.setTimeout(() => setMarkdownRenderAttempt(1), 80)
              return
            }
            setRenderFailed(true)
            onShowToast('渲染连续失败，已切换纯文本视图', 'warning')
          }}
        >
          <Suspense fallback={<div className="reader-content"><Loader2 className="loading-spinner" /> 正在加载 Markdown 阅读器...</div>}>
            <MarkdownReader
              content={document.content}
              documentPath={document.archiveRelativePath ?? document.fileName}
              resources={document.archiveResources}
              contentRef={contentRef}
              themeMode={resolvedTheme}
              onOpenExternalLink={handleOpenExternalLink}
              onOpenDocumentLink={handleOpenDocumentLink}
              searchQuery={debouncedQuery}
              forceHeadingId={activeHeadingId}
              renderAll={richCopyRenderAll}
              onPlanReady={handleRenderPlanReady}
              onRenderChange={handleRenderChange}
            />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        <TextReader content={document.content} />
      )}

      </div>

      <div
        className={`reader-toolbar${readerToolsOpen ? ' open' : ''}`}
        aria-label="阅读工具"
        style={readerToolbarY === null ? undefined : { bottom: `${(1 - readerToolbarY) * 100}svh` }}
      >
        {readerToolsOpen && <div className="reader-tool-menu">
          <button type="button" onClick={toggleTheme}>
            {resolvedTheme === 'light' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{themePreferenceLabel(settings.themeMode)}</span>
          </button>
          <button type="button" onClick={() => changeFontSize(-1)}>
            <SlidersHorizontal size={18} />
            <span>A-</span>
          </button>
          <button type="button" onClick={() => changeFontSize(1)}>
            <SlidersHorizontal size={18} />
            <span>A+</span>
          </button>
          <button type="button" onClick={copyText}>
            <Copy size={18} />
            <span>复制</span>
          </button>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ top: -scrollRef.current.clientHeight * 0.86, behavior: 'smooth' })}>
            <ChevronUp size={18} />
            <span>上一页</span>
          </button>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.86, behavior: 'smooth' })}>
            <ChevronDown size={18} />
            <span>下一页</span>
          </button>
        </div>}
        <button
          className="reader-tool-toggle"
          type="button"
          onPointerDown={handleReaderToolbarPointerDown}
          onPointerMove={handleReaderToolbarPointerMove}
          onPointerUp={finishReaderToolbarDrag}
          onPointerCancel={(event) => {
            finishReaderToolbarDrag(event)
            window.setTimeout(() => { readerToolbarDragRef.current.suppressClick = false })
          }}
          onClick={() => {
            if (readerToolbarDragRef.current.suppressClick) {
              readerToolbarDragRef.current.suppressClick = false
              return
            }
            setReaderToolsOpen((open) => !open)
          }}
          onDoubleClick={resetReaderToolbarPosition}
          aria-expanded={readerToolsOpen}
          aria-label={readerToolsOpen ? '收起阅读工具' : '展开阅读工具'}
          title="拖动可调整位置，双击恢复默认位置"
        >
          {readerToolsOpen ? <X size={20} /> : <SlidersHorizontal size={20} />}
        </button>
      </div>

      {!Capacitor.isNativePlatform() && selectionAction && (
        <div
          className="selection-actions"
          role="toolbar"
          aria-label="所选文字操作"
          style={{ left: selectionAction.x, top: selectionAction.y }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <button type="button" onClick={() => { void saveSelectionAnnotation('highlight', selectionAction, 'yellow') }} aria-label="黄色高亮"><span className="highlight-swatch yellow" /></button>
          <button type="button" onClick={() => { void saveSelectionAnnotation('highlight', selectionAction, 'green') }} aria-label="绿色高亮"><span className="highlight-swatch green" /></button>
          <button type="button" onClick={() => { void saveSelectionAnnotation('highlight', selectionAction, 'blue') }} aria-label="蓝色高亮"><span className="highlight-swatch blue" /></button>
          <button type="button" onClick={() => { void saveSelectionAnnotation('note') }}><MessageSquare size={16} />批注</button>
          <button type="button" onClick={() => { setShareCardText(selectionAction.anchor.exact); setSelectionAction(null); window.getSelection()?.removeAllRanges() }}><Share2 size={16} />卡片</button>
          <button type="button" onClick={() => setSelectionAction(null)} aria-label="关闭"><X size={15} /></button>
        </div>
      )}

      {tocOpen && (
        <div className="mobile-only mobile-directory-sheet">
          <Sheet title="目录" onClose={() => setTocOpen(false)}>
            {renderTableOfContents(true)}
          </Sheet>
        </div>
      )}
      {packageOpen && (
        <Sheet title={`文档包 · ${document.packageName ?? '目录'}`} onClose={() => setPackageOpen(false)}>
          <div className="toc-list package-entry-list">
            {packageDocuments.map((item, index) => (
              <button
                key={item.id}
                className={`toc-item${item.id === document.id ? ' active' : ''}`}
                type="button"
                onClick={() => {
                  setPackageOpen(false)
                  onOpenPackageDocument(item)
                }}
              >
                {index + 1}. {item.archiveRelativePath ?? item.fileName}{item.isFavorite ? ' ★' : ''}
              </button>
            ))}
          </div>
          <div className="package-navigation">
            <button
              type="button"
              disabled={packageDocuments.findIndex((item) => item.id === document.id) <= 0}
              onClick={() => {
                const index = packageDocuments.findIndex((item) => item.id === document.id)
                if (index > 0) onOpenPackageDocument(packageDocuments[index - 1])
              }}
            >上一篇</button>
            <button
              type="button"
              disabled={packageDocuments.findIndex((item) => item.id === document.id) >= packageDocuments.length - 1}
              onClick={() => {
                const index = packageDocuments.findIndex((item) => item.id === document.id)
                if (index >= 0 && index < packageDocuments.length - 1) onOpenPackageDocument(packageDocuments[index + 1])
              }}
            >下一篇</button>
          </div>
        </Sheet>
      )}

      {annotationsOpen && (
        <Sheet title="批注与书签" onClose={() => setAnnotationsOpen(false)}>
          {renderAnnotationBrowser()}
        </Sheet>
      )}

      {shareCardText !== null && (
        <Sheet title="生成阅读卡片" onClose={() => setShareCardText(null)}>
          <div className="share-card-settings">
            <div className="share-card-template-tabs" aria-label="卡片模板">
              {([['simple', '简洁'], ['dark', '深色'], ['accent', '强调']] as const).map(([value, label]) => (
                <button key={value} type="button" className={shareCardTemplate === value ? 'active' : ''} onClick={() => setShareCardTemplate(value)}>{label}</button>
              ))}
            </div>
            <textarea value={shareCardText} maxLength={5000} onChange={(event) => setShareCardText(event.target.value)} aria-label="卡片正文" />
            <input value={shareCardSourceUrl} onChange={(event) => {
              const value = event.target.value
              setShareCardSourceUrl(value)
              if (!/^https?:\/\/[^\s]+$/i.test(value.trim())) setShareCardQrEnabled(false)
            }} placeholder="可选来源链接（https://…）" aria-label="卡片来源链接" />
            <label className="share-card-qr-toggle">
              <input type="checkbox" checked={shareCardQrEnabled} disabled={!validShareCardUrl} onChange={(event) => setShareCardQrEnabled(event.target.checked)} />
              在卡片中显示来源二维码
            </label>
          </div>
          <div className="share-card-preview" ref={shareCardContainerRef}>
            {shareCardPages.map((page, index) => (
              <article className={`share-card-page template-${shareCardTemplate}`} key={`${page.sourceIndex}-${page.text.slice(0, 12)}`}>
                {shareCardPages.length > 1 && <button type="button" className="share-card-remove" onClick={() => setRemovedShareCardPages((items) => [...items, page.sourceIndex])} aria-label="删除此页"><X size={16} /></button>}
                <span className="share-card-brand">LIGHTPAGE · 轻页</span>
                <blockquote>{page.text}</blockquote>
                <footer>
                  <div><strong>{document.fileName}</strong>{shareCardSourceUrl && <small>{shareCardSourceUrl}</small>}</div>
                  {shareCardQrDataUrl && <img src={shareCardQrDataUrl} alt="来源二维码" />}
                </footer>
                {shareCardPages.length > 1 && <span className="share-card-page-number">{index + 1}/{shareCardPages.length}</span>}
              </article>
            ))}
          </div>
          <button className="primary-action compact" type="button" disabled={exporting || !shareCardText.trim()} onClick={() => { void exportShareCards() }}>{exporting ? '生成中…' : `生成并分享 ${shareCardPages.length} 张卡片`}</button>
        </Sheet>
      )}

      {menuOpen && (
        <>
          <div className="mobile-only mobile-file-menu">
            <Sheet title="文件操作" onClose={() => setMenuOpen(false)}>
              {fileMenu}
            </Sheet>
          </div>
          <DesktopPopover title="文件操作" position={menuPosition} onClose={() => setMenuOpen(false)}>
            {fileMenu}
          </DesktopPopover>
        </>
      )}

      {imageExportOpen && (
        <Sheet title="图片导出范围" onClose={() => setImageExportOpen(false)}>
          <p className="sheet-description">全文过长时会自动降低清晰度；分页模式可避免单张图片难以打开。</p>
          <div className="menu-list">
            <MenuAction icon={<ImageDown size={18} />} label="当前可见区域" onClick={() => { setImageExportOpen(false); void shareAsImage('visible') }} />
            <MenuAction icon={<ImageDown size={18} />} label="完整全文" onClick={() => { setImageExportOpen(false); void shareAsImage('full') }} />
            <MenuAction icon={<ImageDown size={18} />} label="分页长图" onClick={() => { setImageExportOpen(false); void shareAsImage('pages') }} />
          </div>
        </Sheet>
      )}

      {encodingOpen && (
        <Sheet title="编码设置" onClose={() => setEncodingOpen(false)}>
          <p className="sheet-description">当前编码：{document.encoding}</p>
          <div className="encoding-list">
            {ENCODING_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`encoding-option${document.encoding.toLowerCase() === opt.value ? ' active' : ''}`}
                type="button"
                onClick={() => switchEncoding(opt.value)}
              >
                <span>{opt.label}</span>
                {document.encoding.toLowerCase() === opt.value && <span className="encoding-check">&#10003;</span>}
              </button>
            ))}
          </div>
          {!document.rawBase64 && (
            <p className="sheet-description muted">文件较大，编码切换需要重新打开文件。</p>
          )}
        </Sheet>
      )}

      {htmlPermissionsOpen && document.fileType === 'html' && (
        <Sheet title="HTML 权限" onClose={() => setHtmlPermissionsOpen(false)}>
          <p className="sheet-description">默认严格沙盒不会执行脚本、提交表单或打开弹窗。权限仅对当前文件生效。</p>
          <div className="permission-list">
            <PermissionToggle
              title="运行脚本"
              description="启用后使用隔离来源运行，目录和文内搜索可能暂不可用。"
              enabled={allowScripts}
              onToggle={() => onUpdate({ allowHtmlScripts: !allowScripts, trustedHtml: false })}
            />
            <PermissionToggle
              title="提交表单"
              description="允许页面内表单交互，但仍禁止自动下载。"
              enabled={allowForms}
              onToggle={() => onUpdate({ allowHtmlForms: !allowForms })}
            />
            <PermissionToggle
              title="打开弹窗"
              description="页面的弹窗请求会转交 App，并在确认后打开。"
              enabled={allowPopups}
              onToggle={() => onUpdate({ allowHtmlPopups: !allowPopups })}
            />
          </div>
          {Capacitor.isNativePlatform() && !document.archiveStorageId && (
            <button className="secondary-action compact" type="button" onClick={() => { void authorizeHtmlResources() }}>
              <FolderOpen size={18} /> 授权同目录图片与样式
            </button>
          )}
          <button
            className="secondary-action compact permission-reset"
            type="button"
            onClick={() => {
              onUpdate({ allowHtmlScripts: false, allowHtmlForms: false, allowHtmlPopups: false, trustedHtml: false })
              setAllowExternalOnce(false)
              onShowToast('已恢复严格沙盒', 'success')
            }}
          >
            恢复严格沙盒
          </button>
        </Sheet>
      )}
      {noteDraft && (
        <div className="note-prompt-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finishNote(null) }}>
          <form className="note-prompt" role="dialog" aria-modal="true" aria-label={noteDraft.title} onSubmit={(event) => { event.preventDefault(); finishNote(noteDraft.value) }}>
            <strong>{noteDraft.title}</strong>
            <textarea autoFocus maxLength={2000} value={noteDraft.value} aria-label="批注内容" onChange={(event) => setNoteDraft({ ...noteDraft, value: event.target.value })} />
            <div className="note-prompt-actions">
              <button type="button" onClick={() => finishNote(null)}>取消</button>
              <button className="primary-action compact" type="submit">确定</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
const MarkdownReader = lazy(() => import('../MarkdownReader'))

