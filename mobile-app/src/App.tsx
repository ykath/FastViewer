import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { base64ToBytes } from './encoding'
import type { DocumentRecord } from './document-types'
import { finishPerformanceSpan, startPerformanceSpan } from './performance-metrics'
import { decodeDocumentBytes } from './decode-document'
import { nextThemePreference } from './reader-settings'
import type { ThemeMode } from './reader-settings'
import { desktopDocumentId, desktopPlatform } from './desktop-platform'
import type { DesktopDirectoryListing, DesktopOpenRequest } from './desktop-platform'
import { isDirectoryPinned, loadPinnedDirectories, normalizeDirectoryPath, pinDirectory, savePinnedDirectories, unpinDirectory } from './desktop-directories'
import type { DirectorySortMode, PinnedDirectory } from './desktop-directories'
import { matchCommandShortcut } from './desktop-commands'
import type { DesktopCommand } from './desktop-commands'
import './App.css'
import {
  FastViewerFiles,
  FILE_SIZE_DANGER,
  FILE_SIZE_WARNING,
} from './app/types'
import type {
  ExternalFileResult,
  FileOpenError,
  FileOpenErrorCode,
  HomeTab,
  NativeOpenRequest,
  ToastState,
  View,
} from './app/types'
import {
  bytesToBase64,
  comparePackageDocuments,
  createRecordFromBytes,
  createRecordFromContent,
  formatBytes,
  getExtension,
  inferFileType,
  isArchiveFileName,
  looksLikeHtml,
  readNativeStoredFile,
  resetViewportScroll,
  sameStringRecord,
  sortDocuments,
  stableDocumentId,
  upsertDocument,
  usePersistentDocuments,
  usePersistentSettings,
} from './app/records'
import { BottomNav, CommandPalette, DirectoryBrowserPopover, LoadingState, OpenErrorState, PasteOpenDialog } from './ui/chrome'
import { HomePage } from './home/HomePage'
import { ReaderPage } from './reader/ReaderPage'

const SettingsPage = lazy(() => import('./SettingsPage'))

function App() {
  const [view, setView] = useState<View>('home')
  const [activeTab, setActiveTab] = useState<HomeTab>('recent')
  const [documents, setDocuments, documentsHydrated, loadStoredDocument, documentRepository] = usePersistentDocuments()
  const [activeDocumentId, setActiveDocumentId] = useState(documents[0]?.id ?? '')
  const [fileError, setFileError] = useState<FileOpenError | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [settings, setSettings] = usePersistentSettings()
  const [systemTheme, setSystemTheme] = useState<ThemeMode>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const [largeSizeConfirm, setLargeSizeConfirm] = useState<{ resolve: (v: boolean) => void; size: number } | null>(null)
  const [pasteDraft, setPasteDraft] = useState<string | null>(null)
  const [failedOpenRequest, setFailedOpenRequest] = useState<NativeOpenRequest | null>(null)
  const [returnDocumentId, setReturnDocumentId] = useState<string | null>(null)
  const [pinnedDirectories, setPinnedDirectories] = useState<PinnedDirectory[]>([])
  const [currentDirectory, setCurrentDirectory] = useState<DesktopDirectoryListing | null>(null)
  const [directoryBrowser, setDirectoryBrowser] = useState<DesktopDirectoryListing | null>(null)
  const [directorySortMode, setDirectorySortMode] = useState<DirectorySortMode>('name-asc')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [readerBackStack, setReaderBackStack] = useState<string[]>([])
  const [linkNavigationHeadingId, setLinkNavigationHeadingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const archiveCleanupStartedRef = useRef(false)
  const openQueueRunningRef = useRef(false)
  const drainOpenQueueRef = useRef<() => void>(() => undefined)
  const toastTimerRef = useRef<number | null>(null)
  const activeDocumentIdRef = useRef(activeDocumentId)
  const viewRef = useRef(view)
  const documentsRef = useRef(documents)
  const desktopRefreshTimersRef = useRef(new Map<string, number>())
  const desktopRefreshInFlightRef = useRef(new Set<string>())
  const desktopRefreshPendingRef = useRef(new Map<string, 'auto' | 'manual'>())
  const desktopRevisionRef = useRef(new Map<string, string>())
  const lastDropRef = useRef({ signature: '', receivedAt: 0, processing: false })
  const isDesktop = desktopPlatform.isDesktop()

  const activeDocument = documents.find((doc) => doc.id === activeDocumentId) ?? documents[0]

  const resolvedTheme: ThemeMode = settings.themeMode === 'system' ? systemTheme : settings.themeMode

  useEffect(() => {
    activeDocumentIdRef.current = activeDocumentId
    viewRef.current = view
    documentsRef.current = documents
  }, [activeDocumentId, documents, view])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return undefined
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    desktopPlatform.applyRuntimeMarker()
  }, [])

  useEffect(() => {
    if (!documentsHydrated || !isDesktop) return undefined
    let disposed = false
    void loadPinnedDirectories(documentRepository).then((items) => {
      if (!disposed) setPinnedDirectories(items)
    })
    return () => { disposed = true }
  }, [documentRepository, documentsHydrated, isDesktop])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined
    let handle: PluginListenerHandle | null = null
    let disposed = false
    void FastViewerFiles.addListener('layoutChanged', (result) => {
      if (!('features' in result)) return
      const fold = result.features.find((item) => item.separating)
      const root = document.documentElement
      if (!fold) {
        delete root.dataset.foldOrientation
        root.style.removeProperty('--fold-left')
        root.style.removeProperty('--fold-top')
        root.style.removeProperty('--fold-width')
        root.style.removeProperty('--fold-height')
        return
      }
      root.dataset.foldOrientation = fold.orientation
      root.style.setProperty('--fold-left', `${fold.left}px`)
      root.style.setProperty('--fold-top', `${fold.top}px`)
      root.style.setProperty('--fold-width', `${Math.max(0, fold.right - fold.left)}px`)
      root.style.setProperty('--fold-height', `${Math.max(0, fold.bottom - fold.top)}px`)
    }).then((listener) => {
      if (disposed) void listener.remove()
      else handle = listener
    })
    return () => {
      disposed = true
      void handle?.remove()
    }
  }, [])

  useEffect(() => {
    if (!documentsHydrated || !Capacitor.isNativePlatform() || archiveCleanupStartedRef.current) return
    archiveCleanupStartedRef.current = true
    const storageIds = Array.from(new Set(documents.flatMap((item) => [item.archiveStorageId, item.resourceStorageId].filter(Boolean)))) as string[]
    void FastViewerFiles.cleanupArchives({ storageIds }).catch(() => undefined)
    void FastViewerFiles.clearRegenerableCache({ limitMb: settings.cacheLimitMb }).catch(() => undefined)
  }, [documents, documentsHydrated, settings.cacheLimitMb])

  useEffect(() => {
    resetViewportScroll()
  }, [view])

  useEffect(() => {
    if (!activeDocumentId && documents[0]) {
      setActiveDocumentId(documents[0].id)
    }
  }, [activeDocumentId, documents])

  const showToast = (message: string, tone: ToastState['tone'] = 'normal') => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ message, tone })
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, 2200)
  }

  const showError = (code: FileOpenErrorCode, message: string) => {
    setFileError({ code, message })
    setView('error')
  }

  const persistDocuments = useCallback((updater: (items: DocumentRecord[]) => DocumentRecord[]) => {
    setDocuments((current) => {
      const next = sortDocuments(updater(current))
      documentsRef.current = next
      return next
    })
  }, [setDocuments])

  const openDocument = async (doc: DocumentRecord, options?: { preserveBackStack?: boolean }) => {
    if (!options?.preserveBackStack) {
      setReaderBackStack([])
    }
    let openedDocument = doc
    if (doc.payloadLoaded === false) {
      setView('loading')
      try {
        if (isDesktop && doc.sourceUri && /^[a-zA-Z]:[\\/]/.test(doc.sourceUri)) {
          const request = await desktopPlatform.prepareDocument(doc.sourceUri, 'picker')
          const bytes = await desktopPlatform.readDocument(request)
          const decoded = await decodeDocumentBytes(bytes)
          const resources = doc.fileType === 'markdown'
            ? await desktopPlatform.loadMarkdownResources(request.path, decoded.content).catch(() => ({}))
            : {}
          openedDocument = {
            ...doc,
            fileSize: bytes.length,
            content: decoded.content,
            rawBase64: decoded.rawBase64,
            encoding: decoded.encoding,
            archiveResources: Object.keys(resources).length ? resources : undefined,
            payloadLoaded: true,
            contentRevision: stableDocumentId(doc.fileName, decoded.content),
          }
          setDocuments((items) => items.map((item) => item.id === doc.id ? openedDocument : item))
        } else if (doc.archiveStorageId && doc.archiveRelativePath && Capacitor.isNativePlatform()) {
          const entry = await FastViewerFiles.openArchiveEntry({
            storageId: doc.archiveStorageId,
            relativePath: doc.archiveRelativePath,
          })
          const resourceResult = await FastViewerFiles.getArchiveResources({ storageId: doc.archiveStorageId })
          const bytes = await readNativeStoredFile(entry.cachedPath, entry.size)
          const decoded = await decodeDocumentBytes(bytes)
          openedDocument = {
            ...doc,
            content: decoded.content,
            rawBase64: decoded.rawBase64,
            encoding: decoded.encoding,
            archiveResources: Object.fromEntries(Object.entries(resourceResult.resources).map(([key, resource]) => [key, Capacitor.convertFileSrc(resource.path)])),
            payloadLoaded: true,
            contentRevision: stableDocumentId(doc.fileName, decoded.content),
          }
          setDocuments((items) => items.map((item) => item.id === doc.id ? openedDocument : item))
        } else {
          openedDocument = await loadStoredDocument(doc.id) ?? doc
        }
      } catch {
        showError('FILE_NOT_FOUND', '文档正文不存在或已被系统清理。')
        return
      }
    }
    const openedAt = new Date().toISOString()
    persistDocuments((items) =>
      upsertDocument(items, { ...openedDocument, lastOpenedAt: openedAt }),
    )
    setActiveDocumentId(openedDocument.id)
    setView('reader')
    if (openedDocument.packageId) {
      void documentRepository.getPackage(openedDocument.packageId).then((item) => {
        if (!item) return
        return documentRepository.savePackage({ ...item, lastEntryId: openedDocument.id, lastOpenedAt: openedAt })
      }).catch(() => undefined)
    }
    if (
      desktopPlatform.isDesktop()
      && openedDocument.fileType === 'markdown'
      && openedDocument.sourceUri
      && !openedDocument.archiveResources
    ) {
      void desktopPlatform.loadMarkdownResources(openedDocument.sourceUri, openedDocument.content)
        .then((resources) => {
          if (Object.keys(resources).length === 0) return
          persistDocuments((items) =>
            upsertDocument(items, { ...openedDocument, archiveResources: resources, lastOpenedAt: openedAt }),
          )
        })
        .catch(() => undefined)
    }
  }

  const importDocument = (doc: DocumentRecord, openAfterImport = true) => {
    persistDocuments((items) => upsertDocument(items, doc))
    if (openAfterImport) {
      setActiveDocumentId(doc.id)
      setView('reader')
    }
  }

  const checkFileSizeAndConfirm = async (size: number): Promise<'open' | 'source' | 'cancel'> => {
    if (size > 0 && size >= FILE_SIZE_DANGER) {
      return new Promise((resolve) => {
        setLargeSizeConfirm({
          resolve: (confirmed) => {
            setLargeSizeConfirm(null)
            resolve(confirmed ? 'open' : 'cancel')
          },
          size,
        })
      })
    }
    if (size > 0 && size >= FILE_SIZE_WARNING) {
      showToast(`文件较大（${formatBytes(size)}），渲染可能较慢`, 'warning')
    }
    return 'open'
  }

  const processBytes = async (
    bytes: Uint8Array,
    fileName: string,
    sourceType: string,
    sourceUri?: string,
    fileSize?: number,
    startedAt = startPerformanceSpan(),
    loadResources?: (content: string) => Promise<Record<string, string>>,
    options: { recordId?: string; openAfterImport?: boolean; silent?: boolean } = {},
  ) => {
    finishPerformanceSpan('content-readable', startedAt, { bytes: bytes.length })
    const decodeStartedAt = startPerformanceSpan()
    const result = await decodeDocumentBytes(bytes)
    finishPerformanceSpan('decode-complete', decodeStartedAt, { bytes: bytes.length, encoding: result.encoding })
    // 原始字节写入独立文件存储，不因文件大小退化为 UTF-8 重写。
    const rawBase64 = result.rawBase64
    let archiveResources: Record<string, string> | undefined
    if (inferFileType(fileName) === 'markdown' && loadResources) {
      try {
        const resources = await loadResources(result.content)
        if (Object.keys(resources).length > 0) archiveResources = resources
      } catch {
        showToast('正文已打开，但同目录图片加载失败', 'warning')
      }
    }

    const record = {
      ...createRecordFromBytes({
      fileName,
      content: result.content,
      encoding: result.encoding,
      rawBase64,
      sourceType,
      sourceUri,
      fileSize: fileSize ?? bytes.length,
      archiveResources,
      }),
      ...(options.recordId ? { id: options.recordId } : {}),
      contentRevision: stableDocumentId(fileName, result.content),
      payloadLoaded: true,
    }

    importDocument(record, options.openAfterImport ?? true)
    finishPerformanceSpan('file-open', startedAt, { bytes: bytes.length, type: record.fileType })

    if (result.confidence === 'low') {
      if (!options.silent) showToast('编码识别置信度较低，可在编码设置中切换', 'warning')
    }

    const displayType = record.fileType === 'html' ? '已安全打开 HTML 文件' : '文件已打开'
    if (!options.silent) showToast(displayType, 'success')
    return record
  }

  const importDesktopRequest = async (request: DesktopOpenRequest, openAfterImport = true, silent = false) => {
    const startedAt = startPerformanceSpan()
    if (openAfterImport && request.size >= FILE_SIZE_DANGER) {
      setView('loading')
      const action = await checkFileSizeAndConfirm(request.size)
      if (action === 'cancel') {
        setView('home')
        return
      }
    } else if (openAfterImport && request.size >= FILE_SIZE_WARNING) {
      showToast(`文件较大（${formatBytes(request.size)}），渲染可能较慢`, 'warning')
    }

    if (openAfterImport) setView('loading')
    try {
      const bytes = await desktopPlatform.readDocument(request)
      const sourceType = request.source === 'picker' ? 'Windows 文件选择器' : 'Windows 资源管理器'
      await processBytes(
        bytes,
        request.fileName,
        sourceType,
        request.path,
        request.size,
        startedAt,
        (content) => desktopPlatform.loadMarkdownResources(request.path, content),
        { recordId: desktopDocumentId(request.path), openAfterImport, silent },
      )
      if (settings.desktopRecentDocuments) void desktopPlatform.addRecentDocument(request.path).catch(() => undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Windows 文件读取失败'
      showError('UNKNOWN', message)
    }
  }

  const importArchiveDocuments = async (result: ExternalFileResult) => {
    const archiveDocuments = result.documents ?? []
    if (archiveDocuments.length === 0) {
      showError('NO_VIEWABLE_FILE', '压缩包中没有 Markdown 或 HTML 文件。')
      return
    }

    const importedAt = Date.now()
    const packageId = result.storageId ?? result.sha256 ?? crypto.randomUUID()
    const existingPackage = await documentRepository.getPackage(packageId)
    if (existingPackage) {
      const existing = documents.find((item) => item.id === existingPackage.lastEntryId)
        ?? documents.find((item) => item.packageId === packageId)
      if (existing) {
        await openDocument(existing)
        showToast('已打开现有文档包', 'success')
        return
      }
    }
    const archiveResources = Object.fromEntries(
      Object.entries(result.resources ?? {}).map(([key, resource]) => {
        if (typeof resource === 'string') return [key, resource]
        return [key, Capacitor.convertFileSrc(resource.path)]
      }),
    )
    const records: DocumentRecord[] = []
    for (let index = 0; index < archiveDocuments.length; index += 1) {
      const item = archiveDocuments[index]
      const relativePath = item.relativePath ?? item.fileName
      const documentId = stableDocumentId(packageId, relativePath)
      let record: DocumentRecord
      if (index === 0) {
        const bytes = item.cachedPath
          ? await readNativeStoredFile(item.cachedPath, item.size)
          : item.base64Content
            ? base64ToBytes(item.base64Content)
            : new Uint8Array()
        if (bytes.length === 0) continue
        const decoded = await decodeDocumentBytes(bytes)
        record = {
          ...createRecordFromBytes({
            fileName: relativePath,
            content: decoded.content,
            encoding: decoded.encoding,
            rawBase64: decoded.rawBase64,
            sourceType: `压缩包：${result.fileName ?? item.archiveName ?? '未知压缩包'}`,
            sourceUri: item.sourceUri ?? result.uri,
            fileSize: item.size ?? bytes.length,
            inLibrary: true,
            lastOpenedAt: new Date(importedAt - index).toISOString(),
            archiveRelativePath: relativePath,
            archiveResources,
            archiveStorageId: packageId,
          }),
          id: documentId,
          packageId,
          packageName: result.fileName,
          payloadLoaded: true,
          contentRevision: stableDocumentId(relativePath, decoded.content),
        }
      } else {
        record = {
          ...createRecordFromContent({
            fileName: relativePath,
            content: '',
            sourceType: `压缩包：${result.fileName ?? item.archiveName ?? '未知压缩包'}`,
            sourceUri: item.sourceUri ?? result.uri,
            fileSize: item.size ?? 0,
            inLibrary: true,
            lastOpenedAt: new Date(importedAt - index).toISOString(),
          }),
          id: documentId,
          archiveRelativePath: relativePath,
          archiveStorageId: packageId,
          packageId,
          packageName: result.fileName,
          payloadLoaded: false,
        }
      }
      records.push(record)
    }

    if (records.length === 0) {
      showError('NO_VIEWABLE_FILE', '压缩包中没有可读取的 Markdown 或 HTML 文件。')
      return
    }

    persistDocuments((items) => records.reduce((next, record) => upsertDocument(next, record), items))
    await documentRepository.savePackage({
      id: packageId,
      fileName: result.fileName ?? '文档包',
      sha256: result.sha256,
      sourceUri: result.uri,
      storageId: packageId,
      originalAvailable: Boolean(result.originalPath),
      durableExtraction: !result.originalPath,
      lastEntryId: records[0].id,
      createdAt: new Date(importedAt).toISOString(),
      lastOpenedAt: new Date(importedAt).toISOString(),
      totalSize: result.size ?? records.reduce((total, item) => total + item.fileSize, 0),
    })
    await documentRepository.savePackageEntries(records.map((item, order) => ({
      id: `${packageId}:${item.archiveRelativePath ?? item.id}`,
      packageId,
      documentId: item.id,
      relativePath: item.archiveRelativePath ?? item.fileName,
      fileName: item.fileName,
      fileType: item.fileType,
      size: item.fileSize,
      order,
      isFavorite: item.isFavorite,
    })))
    setActiveDocumentId(records[0].id)
    setView('reader')
    showToast(`已从压缩包导入 ${records.length} 个可查看文件`, 'success')
  }

  const importExternalResult = async (result: ExternalFileResult, fromQueue = false): Promise<boolean> => {
    if (result.error || result.errorCode) {
      const code = (result.errorCode as FileOpenErrorCode) || 'UNKNOWN'
      showError(code, result.error || '外部文件读取失败')
      return false
    }

    if (!result.hasFile) return false
    if (fromQueue && viewRef.current === 'reader' && activeDocumentIdRef.current) {
      setReturnDocumentId(activeDocumentIdRef.current)
    }

    if (result.isArchive || result.documents?.length) {
      setView('loading')
      try {
        await importArchiveDocuments(result)
        return true
      } catch {
        showError('ARCHIVE_FAILED', '压缩包内容处理失败，请确认文件未损坏。')
        return false
      }
    }

    // Backwards compat: if native sent base64Content, use new pipeline
    if (result.base64Content && result.fileName) {
      const size = result.size ?? 0

      if (size > 0 && size >= FILE_SIZE_DANGER) {
        setView('loading')
        const action = await checkFileSizeAndConfirm(size)
        if (action === 'cancel') {
          setView('home')
          return false
        }
      } else if (size > 0 && size >= FILE_SIZE_WARNING) {
        showToast(`文件较大（${formatBytes(size)}），渲染可能较慢`, 'warning')
      }

      setView('loading')
      try {
        const bytes = base64ToBytes(result.base64Content)
        await processBytes(bytes, result.fileName, '外部应用', result.uri, result.size)
        return true
      } catch {
        showError('UNKNOWN', '文件解码失败，请尝试重新打开。')
        return false
      }
    }

    if (result.cachedPath && result.fileName) {
      const size = result.size ?? 0
      if (size > 0 && size >= FILE_SIZE_DANGER) {
        setView('loading')
        const action = await checkFileSizeAndConfirm(size)
        if (action === 'cancel') {
          await FastViewerFiles.releaseStoredFile({ path: result.cachedPath }).catch(() => undefined)
          setView('home')
          return false
        }
      } else if (size > 0 && size >= FILE_SIZE_WARNING) {
        showToast(`文件较大（${formatBytes(size)}），渲染可能较慢`, 'warning')
      }

      setView('loading')
      try {
        const bytes = await readNativeStoredFile(result.cachedPath, result.size)
        await processBytes(bytes, result.fileName, '外部应用', result.uri, result.size)
        return true
      } catch {
        showError('UNKNOWN', '文件分块读取失败，请尝试重新打开。')
        return false
      } finally {
        if (!result.requestId) await FastViewerFiles.releaseStoredFile({ path: result.cachedPath }).catch(() => undefined)
      }
    }

    // Legacy fallback: old native sent content as string
    if (result.content && result.fileName) {
      const record = createRecordFromBytes({
        fileName: result.fileName,
        content: result.content,
        encoding: 'utf-8',
        sourceType: '外部应用',
        sourceUri: result.uri,
        fileSize: result.size,
      })
      importDocument(record)
      showToast('已从外部应用打开文件', 'success')
      return true
    }
    return false
  }

  const loadExternalLaunchFile = async () => {
    if (!Capacitor.isNativePlatform()) return

    try {
      const result = await FastViewerFiles.getLaunchFile()
      await importExternalResult(result)
    } catch (error) {
      showError('UNKNOWN', error instanceof Error ? error.message : '外部文件读取失败')
    }
  }

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !documentsHydrated) return undefined
    let disposed = false
    let handle: PluginListenerHandle | undefined
    const drainQueue = async () => {
      if (disposed || openQueueRunningRef.current) return
      openQueueRunningRef.current = true
      try {
        const { requests } = await FastViewerFiles.getPendingOpenRequests()
        for (const request of requests) {
          if (disposed) break
          if (request.error) {
            setFailedOpenRequest(request)
            showToast(`${request.fileName} 等待处理`, 'warning')
            break
          }
          try {
            const result = await FastViewerFiles.resolveOpenRequest({ requestId: request.requestId })
            const imported = await importExternalResult(result, true)
            if (!imported) break
            await FastViewerFiles.acknowledgeOpenRequest({ requestId: request.requestId })
          } catch (error) {
            setFailedOpenRequest({ ...request, error: error instanceof Error ? error.message : '外部打开请求处理失败' })
            break
          }
        }
      } finally {
        openQueueRunningRef.current = false
      }
    }
    drainOpenQueueRef.current = () => { void drainQueue() }
    void FastViewerFiles.addListener('openRequestAvailable', () => { void drainQueue() }).then((listenerHandle) => {
      handle = listenerHandle
      void drainQueue()
    }).catch(() => {
      // Older native builds keep the legacy launch-file API available.
      void loadExternalLaunchFile()
    })
    return () => {
      disposed = true
      drainOpenQueueRef.current = () => undefined
      void handle?.remove()
    }
    // Queue ownership and serialization start only after v3 hydration, so migration cannot overwrite an import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsHydrated])

  useEffect(() => {
    // Do not consume a launch/association request until IndexedDB hydration has
    // finished. Otherwise the later hydration result can replace the document
    // that was just opened from Explorer, making a successful double-click look
    // like it was ignored.
    if (!isDesktop || !documentsHydrated) return undefined
    let disposed = false
    let unlisten: (() => void) | undefined

    void desktopPlatform.listenForOpenRequests(importDesktopRequest).then((removeListener) => {
      if (disposed) {
        removeListener()
        return
      }
      unlisten = removeListener
    }).catch((error) => {
      if (!disposed) showError('UNKNOWN', error instanceof Error ? error.message : 'Windows 文件关联初始化失败')
    })

    return () => {
      disposed = true
      unlisten?.()
    }
    // The desktop bridge owns event serialization and is initialized once per app mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsHydrated, isDesktop])

  const handlePickedFile = async (file: File) => {
    const startedAt = startPerformanceSpan()
    try {
      if (!isArchiveFileName(file.name) && !['md', 'markdown', 'mdown', 'html', 'htm', 'xhtml'].includes(getExtension(file.name))) {
        showError('UNSUPPORTED_TYPE', '当前仅支持 Markdown、HTML、ZIP 和 RAR 文件。')
        return
      }
      if (isArchiveFileName(file.name)) {
        if (!Capacitor.isNativePlatform()) {
          showError('UNSUPPORTED_TYPE', '压缩包导入需要在 Android App 中使用。')
          return
        }

        setView('loading')
        const buffer = await file.arrayBuffer()
        const result = await FastViewerFiles.importArchive({
          fileName: file.name,
          base64Content: bytesToBase64(new Uint8Array(buffer)),
          mimeType: file.type,
          size: file.size,
        })
        await importExternalResult(result)
        return
      }

      const size = file.size
      if (size >= FILE_SIZE_DANGER) {
        setView('loading')
        const action = await checkFileSizeAndConfirm(size)
        if (action === 'cancel') {
          setView('home')
          if (fileInputRef.current) fileInputRef.current.value = ''
          return
        }
      } else if (size >= FILE_SIZE_WARNING) {
        showToast(`文件较大（${formatBytes(size)}），渲染可能较慢`, 'warning')
      }

      setView('loading')
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      await processBytes(bytes, file.name, '文件选择器', undefined, file.size, startedAt)
    } catch {
      showError('UNKNOWN', '文件读取失败，请确认文件仍可访问。')
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const openFilePicker = async () => {
    if (isDesktop) {
      try {
        const request = await desktopPlatform.pickDocument()
        if (request) await importDesktopRequest(request)
      } catch (error) {
        showError('UNKNOWN', error instanceof Error ? error.message : 'Windows 文件选择失败')
      }
      return
    }
    if (!Capacitor.isNativePlatform()) {
      fileInputRef.current?.click()
      return
    }
    setView('loading')
    try {
      const result = await FastViewerFiles.pickFile()
      await importExternalResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件选择失败'
      if (/cancel/i.test(message)) setView('home')
      else showError('UNKNOWN', message)
    }
  }

  const updateActiveDocument = useCallback((patch: Partial<DocumentRecord>) => {
    if (!activeDocumentId) return
    persistDocuments((items) =>
      items.map((item) =>
        item.id === activeDocumentId ? { ...item, ...patch } : item,
      ),
    )
  }, [activeDocumentId, persistDocuments])

  const deleteDocument = async (doc: DocumentRecord) => {
    if (doc.packageId) {
      const entries = documents.filter((item) => item.packageId === doc.packageId)
      const favoriteCount = entries.filter((item) => item.isFavorite).length
      const annotationCount = (await Promise.all(entries.map((item) => documentRepository.listAnnotations(item.id).catch(() => []))))
        .reduce((total, items) => total + items.length, 0)
      const warning = `确定删除文档包“${doc.packageName ?? doc.fileName}”及其中 ${entries.length} 篇文档、${annotationCount} 条批注吗？${favoriteCount ? `其中 ${favoriteCount} 篇已收藏。` : ''}`
      if (!window.confirm(warning) || (favoriteCount > 0 && !window.confirm('已收藏内容和对应批注也会删除，请再次确认。'))) return
      persistDocuments((items) => items.filter((item) => item.packageId !== doc.packageId))
      if (doc.archiveStorageId) void FastViewerFiles.releaseArchive({ storageId: doc.archiveStorageId }).catch(() => undefined)
      void documentRepository.deletePackage(doc.packageId).catch(() => undefined)
      if (entries.some((item) => item.id === activeDocumentId)) {
        const next = documents.find((item) => item.packageId !== doc.packageId)
        setActiveDocumentId(next?.id ?? '')
      }
      showToast('已删除文档包及其本地数据', 'success')
      return
    }
    persistDocuments((items) => items.filter((item) => item.id !== doc.id))
    if (activeDocumentId === doc.id) {
      const next = documents.find((item) => item.id !== doc.id)
      setActiveDocumentId(next?.id ?? '')
    }
    if (doc.archiveStorageId && documents.filter((item) => item.archiveStorageId === doc.archiveStorageId).length === 1) {
      void FastViewerFiles.releaseArchive({ storageId: doc.archiveStorageId }).catch(() => undefined)
    }
    if (doc.resourceStorageId) {
      void FastViewerFiles.releaseArchive({ storageId: doc.resourceStorageId }).catch(() => undefined)
    }
    showToast('已删除本地记录', 'success')
  }

  const openPasteDialog = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setPasteDraft(text)
    } catch {
      setPasteDraft('')
      showToast('无法自动读取剪贴板，请长按输入框粘贴', 'warning')
    }
  }

  const confirmPasteOpen = () => {
    const content = pasteDraft?.trim() ?? ''
    if (!content) {
      showToast('剪贴板内容为空', 'warning')
      return
    }
    const html = looksLikeHtml(content)
    const suffix = html ? 'html' : 'md'
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const record = createRecordFromContent({
      fileName: `粘贴内容-${timestamp}.${suffix}`,
      content,
      sourceType: '剪贴板',
      inLibrary: true,
    })
    importDocument(record)
    setPasteDraft(null)
    showToast(`已按${html ? ' HTML' : ' Markdown'}打开剪贴板内容`, 'success')
  }

  const persistPinnedDirectoryState = (next: PinnedDirectory[]) => {
    setPinnedDirectories(next)
    void savePinnedDirectories(documentRepository, next)
      .catch(() => showToast('目录收藏保存失败', 'warning'))
  }

  const toggleCurrentDirectoryPin = () => {
    if (!currentDirectory) return
    const pinned = isDirectoryPinned(pinnedDirectories, currentDirectory.path)
    const next = pinned
      ? unpinDirectory(pinnedDirectories, currentDirectory.path)
      : pinDirectory(pinnedDirectories, currentDirectory.path, currentDirectory.name)
    persistPinnedDirectoryState(next)
    showToast(pinned ? '已取消目录收藏' : '已固定当前目录', 'success')
  }

  const openDirectoryDocument = async (
    path: string,
    options?: { fromDocumentLink?: boolean; headingId?: string },
  ) => {
    try {
      if (options?.fromDocumentLink) {
        if (activeDocumentId) setReaderBackStack((stack) => [...stack, activeDocumentId])
        if (options.headingId) setLinkNavigationHeadingId(options.headingId)
      } else {
        setReaderBackStack([])
      }
      const request = await desktopPlatform.prepareDocument(path, 'picker')
      setDirectoryBrowser(null)
      await importDesktopRequest(request)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '目录中的文件无法打开', 'warning')
    }
  }

  const handleReaderBack = useCallback(() => {
    if (readerBackStack.length > 0) {
      const previousId = readerBackStack[readerBackStack.length - 1]
      setReaderBackStack((stack) => stack.slice(0, -1))
      setActiveDocumentId(previousId)
      setView('reader')
      return
    }
    setReaderBackStack([])
    setView('home')
  }, [readerBackStack])

  const browsePinnedDirectory = async (directory: PinnedDirectory) => {
    if (directoryBrowser && normalizeDirectoryPath(directoryBrowser.path) === normalizeDirectoryPath(directory.path)) {
      setDirectoryBrowser(null)
      return
    }
    try {
      setDirectoryBrowser(await desktopPlatform.listDirectoryDocuments(directory.path))
    } catch {
      showToast(`目录“${directory.name}”不可访问，可取消收藏后重新固定`, 'warning')
    }
  }

  const refreshDesktopDocument = async (documentId: string, trigger: 'auto' | 'manual' = 'auto') => {
    if (desktopRefreshInFlightRef.current.has(documentId)) {
      const pending = desktopRefreshPendingRef.current.get(documentId)
      if (trigger === 'manual' || !pending) desktopRefreshPendingRef.current.set(documentId, trigger)
      return false
    }
    desktopRefreshInFlightRef.current.add(documentId)
    let nextTrigger: 'auto' | 'manual' = trigger
    let refreshed = false
    try {
      do {
        desktopRefreshPendingRef.current.delete(documentId)
        const current = documentsRef.current.find((item) => item.id === documentId)
        if (!current?.sourceUri) return false
        if (nextTrigger !== 'manual') {
          try {
            const revision = await desktopPlatform.getDocumentRevision(current.sourceUri)
            const fingerprint = `${revision.modifiedAtNanos}:${revision.size}`
            if (desktopRevisionRef.current.get(documentId) === fingerprint) {
              if (!desktopRefreshPendingRef.current.has(documentId)) return false
              continue
            }
            desktopRevisionRef.current.set(documentId, fingerprint)
          } catch {
            // Fall through when the file is mid-save and the revision cannot be read yet.
          }
        }
        try {
          const request = await desktopPlatform.prepareDocument(current.sourceUri, 'picker')
          const bytes = await desktopPlatform.readStableDocument(request)
          const decoded = await decodeDocumentBytes(bytes)
          let resources: Record<string, string> = {}
          if (current.fileType === 'markdown') {
            try {
              resources = await desktopPlatform.loadMarkdownResources(request.path, decoded.content)
            } catch {
              // A referenced image can be locked or replaced during an editor's
              // atomic save. Keep the last good resource snapshot in that window.
              resources = current.archiveResources ?? {}
            }
          }
          const changed = current.content !== decoded.content
            || current.encoding !== decoded.encoding
            || current.fileSize !== bytes.length
            || !sameStringRecord(current.archiveResources, resources)
          if (changed) {
            persistDocuments((items) => items.map((item) => item.id === documentId ? {
              ...item,
              content: decoded.content,
              rawBase64: decoded.rawBase64,
              encoding: decoded.encoding,
              fileSize: bytes.length,
              archiveResources: Object.keys(resources).length ? resources : undefined,
              contentRevision: stableDocumentId(item.fileName, decoded.content),
              payloadLoaded: true,
            } : item))
            refreshed = true
          }
          if (current.fileType === 'markdown') {
            void desktopPlatform.resolveMarkdownResourcePaths(request.path, decoded.content)
              .then((resourcePaths) => desktopPlatform.watchDocument(documentId, request.path, resourcePaths))
              .catch(() => undefined)
          }
          if (nextTrigger === 'manual') {
            showToast(changed ? `已重新加载 ${current.fileName}` : `${current.fileName} 已是最新`, 'success')
          } else if (changed) {
            showToast(`已自动同步 ${current.fileName}`, 'success')
          }
        } catch {
          const current = documentsRef.current.find((item) => item.id === documentId)
          showToast(
            nextTrigger === 'manual'
              ? `重新加载失败：${current?.fileName ?? '当前文件'} 已删除、移动或暂时不可访问`
              : `${current?.fileName ?? '当前文件'} 已删除、移动或暂时不可访问`,
            'warning',
          )
          return refreshed
        }
        nextTrigger = desktopRefreshPendingRef.current.get(documentId) ?? 'auto'
      } while (desktopRefreshPendingRef.current.has(documentId))
      return refreshed
    } finally {
      desktopRefreshInFlightRef.current.delete(documentId)
    }
  }

  const dispatchReaderCommand = (command: string) => {
    window.dispatchEvent(new CustomEvent('lightpage-reader-command', { detail: command }))
  }

  const desktopCommands: DesktopCommand[] = [
    { id: 'file.open', title: '打开文件', keywords: ['open'], shortcut: 'Ctrl+O', run: () => openFilePicker() },
    { id: 'document.reload', title: '重新加载当前文件', keywords: ['reload', 'refresh', '同步'], shortcut: 'Ctrl+R', enabled: () => view === 'reader' && Boolean(activeDocument?.sourceUri), run: () => activeDocument ? refreshDesktopDocument(activeDocument.id, 'manual') : undefined },
    { id: 'directory.pin', title: currentDirectory && isDirectoryPinned(pinnedDirectories, currentDirectory.path) ? '取消固定当前目录' : '固定当前目录', keywords: ['folder', 'directory'], enabled: () => Boolean(currentDirectory), run: toggleCurrentDirectoryPin },
    { id: 'document.find', title: '在当前文档中查找', keywords: ['search'], shortcut: 'Ctrl+F', enabled: () => view === 'reader', run: () => dispatchReaderCommand('find') },
    { id: 'document.favorite', title: activeDocument?.isFavorite ? '取消收藏当前文档' : '收藏当前文档', shortcut: 'Ctrl+D', enabled: () => Boolean(activeDocument), run: () => updateActiveDocument({ isFavorite: !activeDocument?.isFavorite }) },
    { id: 'document.toc', title: '显示或隐藏章节目录', shortcut: 'Ctrl+B', enabled: () => view === 'reader', run: () => dispatchReaderCommand('toc') },
    { id: 'document.export', title: '导出当前文档', shortcut: 'Ctrl+Shift+E', enabled: () => view === 'reader', run: () => dispatchReaderCommand('export') },
    { id: 'reader.theme', title: '切换阅读主题', shortcut: 'Ctrl+Shift+T', run: () => setSettings({ ...settings, themeMode: nextThemePreference(settings.themeMode) }) },
    { id: 'reader.font-increase', title: '增大字号', shortcut: 'Ctrl+=', enabled: () => view === 'reader', run: () => dispatchReaderCommand('font-increase') },
    { id: 'reader.font-decrease', title: '减小字号', shortcut: 'Ctrl+-', enabled: () => view === 'reader', run: () => dispatchReaderCommand('font-decrease') },
    { id: 'reader.font-reset', title: '恢复默认字号', shortcut: 'Ctrl+0', enabled: () => view === 'reader', run: () => dispatchReaderCommand('font-reset') },
    { id: 'document.close', title: '关闭当前阅读页', shortcut: 'Ctrl+W', enabled: () => view === 'reader', run: () => setView('home') },
  ]

  useEffect(() => {
    if (!isDesktop) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase() === 'p') {
        event.preventDefault()
        setCommandPaletteOpen(true)
        return
      }
      if (commandPaletteOpen && event.key === 'Escape') {
        event.preventDefault()
        setCommandPaletteOpen(false)
        return
      }
      const command = matchCommandShortcut(event, desktopCommands)
      if (!command) return
      event.preventDefault()
      void command.run()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    if (!isDesktop) return undefined
    let disposed = false
    let remove: (() => void) | undefined
    void desktopPlatform.listenForDrops(async (paths) => {
      const signature = paths.map((path) => path.replace(/\\/g, '/').toLocaleLowerCase()).sort().join('|')
      const now = Date.now()
      if (lastDropRef.current.processing
        || (lastDropRef.current.signature === signature && now - lastDropRef.current.receivedAt < 1_200)) return
      lastDropRef.current = { signature, receivedAt: now, processing: true }
      try {
        const classified = await desktopPlatform.classifyDropPaths(paths)
        if (disposed) return
        if (classified.files[0]) await importDesktopRequest(classified.files[0])
        if (classified.files.length > 1) showToast(`已打开首个文件，忽略其余 ${classified.files.length - 1} 个文件`, 'warning')
        if (classified.directories.length > 0) showToast('请先打开目录内的文档，再从左侧固定该目录', 'warning')
        if (classified.rejected) showToast(`${classified.rejected} 个项目不受支持或无法访问`, 'warning')
      } finally {
        lastDropRef.current.processing = false
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else remove = unlisten
    })
    return () => {
      disposed = true
      remove?.()
    }
    // Register exactly one native listener. The handler intentionally uses the
    // initial stable desktop bridge and state setters; re-registering caused one
    // physical drop to be consumed several times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop])

  useEffect(() => {
    if (!isDesktop || !activeDocument?.sourceUri) {
      setCurrentDirectory(null)
      return undefined
    }
    let disposed = false
    void desktopPlatform.listDirectoryDocuments(activeDocument.sourceUri)
      .then((listing) => { if (!disposed) setCurrentDirectory(listing) })
      .catch(() => { if (!disposed) setCurrentDirectory(null) })
    return () => { disposed = true }
  }, [activeDocument?.contentRevision, activeDocument?.sourceUri, isDesktop])

  useEffect(() => {
    if (!isDesktop || view !== 'reader' || !activeDocument?.sourceUri) return undefined
    const documentId = activeDocument.id
    const documentPath = activeDocument.sourceUri
    const refreshTimers = desktopRefreshTimersRef.current
    let disposed = false
    let remove: (() => void) | undefined
    let revisionFingerprint: string | null = null
    let revisionCheckRunning = false
    const scheduleRefresh = (delay = 350) => {
      const existing = refreshTimers.get(documentId)
      if (existing) window.clearTimeout(existing)
      const timer = window.setTimeout(() => {
        refreshTimers.delete(documentId)
        if (!disposed) void refreshDesktopDocument(documentId)
      }, delay)
      refreshTimers.set(documentId, timer)
    }
    const checkRevision = async () => {
      if (disposed || revisionCheckRunning) return
      revisionCheckRunning = true
      try {
        const revision = await desktopPlatform.getDocumentRevision(documentPath)
        if (disposed) return
        const nextFingerprint = `${revision.modifiedAtNanos}:${revision.size}`
        if (!desktopRevisionRef.current.has(documentId)) desktopRevisionRef.current.set(documentId, nextFingerprint)
        if (revisionFingerprint !== null && revisionFingerprint !== nextFingerprint) scheduleRefresh(250)
        revisionFingerprint = nextFingerprint
      } catch {
        // Atomic-save editors can briefly remove the destination file. The native
        // watcher still schedules a retry, and the next poll observes recreation.
      } finally {
        revisionCheckRunning = false
      }
    }
    void desktopPlatform.listenForFileChanges((change) => {
      if (change.documentId === documentId) scheduleRefresh()
    }).then((unlisten) => {
      if (disposed) unlisten()
      else remove = unlisten
    })
    void checkRevision()
    void desktopPlatform.resolveMarkdownResourcePaths(documentPath, activeDocument.content)
      .then(async (resources) => {
        if (disposed) return
        await desktopPlatform.watchDocument(documentId, documentPath, resources)
        if (disposed) await desktopPlatform.unwatchDocument(documentId)
      })
      .catch(() => undefined)
    const pollTimer = window.setInterval(() => { void checkRevision() }, 1_000)
    return () => {
      disposed = true
      remove?.()
      window.clearInterval(pollTimer)
      const pending = refreshTimers.get(documentId)
      if (pending) {
        window.clearTimeout(pending)
        refreshTimers.delete(documentId)
      }
      void desktopPlatform.unwatchDocument(documentId)
    }
  // Content changes must not recreate the watcher: an async cleanup could remove
  // the replacement watcher and stop all later refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocument?.id, activeDocument?.sourceUri, isDesktop, view])

  return (
    <div className={`app-shell view-${view}`}>
      {documentsHydrated && <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".md,.markdown,.mdown,.html,.htm,.xhtml,.zip,.rar,text/markdown,text/html,application/zip,application/x-zip-compressed,application/vnd.rar,application/x-rar-compressed"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handlePickedFile(file)
        }}
      />}

      <main className="app-main">
        {view === 'home' && (
          <HomePage
            activeTab={activeTab}
            documents={documents}
            onTabChange={setActiveTab}
            onOpenFile={(document) => { void openDocument(document) }}
            onPickFile={() => { void openFilePicker() }}
            onPasteOpen={() => { void openPasteDialog() }}
            onDelete={deleteDocument}
            onRevealFile={isDesktop ? (document) => {
              if (!document.sourceUri) return
              void desktopPlatform.revealInFileManager(document.sourceUri)
                .catch(() => showToast('无法通过资源管理器打开文件所在目录', 'warning'))
            } : undefined}
            onClearTab={(tab) => {
              if (tab === 'favorite') {
                persistDocuments((items) => items.map((item) => ({ ...item, isFavorite: false })))
              } else if (tab === 'library') {
                persistDocuments((items) => items.map((item) => ({ ...item, inLibrary: false })))
              } else {
                const removable = documents.filter((item) => !item.isFavorite && !item.inLibrary)
                const remaining = documents.filter((item) => item.isFavorite || item.inLibrary)
                const remainingStorage = new Set(remaining.flatMap((item) => [item.archiveStorageId, item.resourceStorageId].filter(Boolean)))
                const removableStorage = new Set(removable.flatMap((item) => [item.archiveStorageId, item.resourceStorageId].filter(Boolean)))
                removableStorage.forEach((storageId) => {
                  if (!remainingStorage.has(storageId)) {
                    void FastViewerFiles.releaseArchive({ storageId: storageId as string }).catch(() => undefined)
                  }
                })
                persistDocuments((items) => items.filter((item) => item.isFavorite || item.inLibrary))
              }
              showToast('已完成批量清理', 'success')
            }}
            onToggleFavorite={(doc) =>
              {
                persistDocuments((items) =>
                items.map((item) =>
                  item.id === doc.id ? { ...item, isFavorite: !item.isFavorite } : item,
                ),
                )
                if (doc.packageId) {
                  void documentRepository.listPackageEntries(doc.packageId)
                    .then((entries) => documentRepository.savePackageEntries(entries.map((entry) => entry.documentId === doc.id ? { ...entry, isFavorite: !doc.isFavorite } : entry)))
                    .catch(() => undefined)
                }
              }
            }
          />
        )}

        {view === 'reader' && activeDocument && (
          <ReaderPage
            document={activeDocument}
            packageDocuments={activeDocument.packageId
              ? documents.filter((item) => item.packageId === activeDocument.packageId)
                .sort(comparePackageDocuments)
              : []}
            settings={settings}
            resolvedTheme={resolvedTheme}
            onBack={handleReaderBack}
            onUpdate={updateActiveDocument}
            onReload={activeDocument.sourceUri ? () => refreshDesktopDocument(activeDocument.id, 'manual') : undefined}
            onShowToast={showToast}
            onSetSettings={setSettings}
            onOpenPackageDocument={(item) => { void openDocument(item) }}
            onOpenPackageDocumentFromLink={(item, options) => {
              if (options.fromDocumentLink && activeDocumentId) {
                setReaderBackStack((stack) => [...stack, activeDocumentId])
              }
              if (options.headingId) setLinkNavigationHeadingId(options.headingId)
              void openDocument(item, { preserveBackStack: true })
            }}
            onOpenDesktopDocument={(path, options) => { void openDirectoryDocument(path, options) }}
            linkNavigationHeadingId={linkNavigationHeadingId}
            onConsumeLinkNavigationHeading={() => setLinkNavigationHeadingId(null)}
            annotationRepository={documentRepository}
            directoryListing={currentDirectory}
            directorySortMode={directorySortMode}
            directoryPinned={Boolean(currentDirectory && isDirectoryPinned(pinnedDirectories, currentDirectory.path))}
            onToggleDirectoryPin={toggleCurrentDirectoryPin}
            onOpenDirectoryDocument={(path) => { void openDirectoryDocument(path) }}
            onDirectorySortModeChange={setDirectorySortMode}
          />
        )}

        {view === 'settings' && (
          <Suspense fallback={<LoadingState />}>
            <SettingsPage settings={settings} resolvedTheme={resolvedTheme} onSetSettings={setSettings} />
          </Suspense>
        )}

        {view === 'error' && (
          <OpenErrorState
            error={fileError}
            onBack={() => setView('home')}
            onPickFile={() => { void openFilePicker() }}
          />
        )}

        {view === 'loading' && <LoadingState />}
      </main>

      <BottomNav
        currentView={view}
        hasReader={Boolean(activeDocument)}
        pinnedDirectories={pinnedDirectories}
        activeDirectoryPath={directoryBrowser?.path}
        onBrowseDirectory={(directory) => { void browsePinnedDirectory(directory) }}
        onRemoveDirectory={(directory) => {
          persistPinnedDirectoryState(unpinDirectory(pinnedDirectories, directory.path))
          if (directoryBrowser?.path === directory.path) setDirectoryBrowser(null)
        }}
        onNavigate={(nextView) => {
          if (nextView === 'reader' && !activeDocument) return
          if (nextView === 'loading') return
          setView(nextView)
        }}
      />

      {isDesktop && directoryBrowser && (
        <DirectoryBrowserPopover
          listing={directoryBrowser}
          activeDocumentPath={activeDocument?.sourceUri}
          sortMode={directorySortMode}
          onOpen={(path) => { void openDirectoryDocument(path) }}
          onClose={() => setDirectoryBrowser(null)}
          onSortModeChange={setDirectorySortMode}
        />
      )}

      {largeSizeConfirm && (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true">
            <header className="sheet-header">
              <h2>文件较大</h2>
            </header>
            <p className="large-file-warning">
              文件大小为 {formatBytes(largeSizeConfirm.size)}，渲染可能较慢甚至卡顿。
            </p>
            <div className="error-actions">
              <button className="primary-action compact" type="button" onClick={() => largeSizeConfirm.resolve(true)}>
                以源码模式打开
              </button>
              <button className="secondary-action compact" type="button" onClick={() => largeSizeConfirm.resolve(false)}>
                取消
              </button>
            </div>
          </section>
        </div>
      )}

      {pasteDraft !== null && (
        <PasteOpenDialog
          value={pasteDraft}
          onChange={setPasteDraft}
          onCancel={() => setPasteDraft(null)}
          onConfirm={confirmPasteOpen}
        />
      )}

      {failedOpenRequest && (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-label="外部打开请求处理失败">
            <header className="sheet-header"><h2>文件尚未导入</h2></header>
            <p className="large-file-warning">{failedOpenRequest.fileName}：{failedOpenRequest.error ?? '处理失败，临时文件已安全保留。'}</p>
            <div className="error-actions">
              <button className="primary-action compact" type="button" onClick={() => {
                setFailedOpenRequest(null)
                drainOpenQueueRef.current()
              }}>重试</button>
              <button className="secondary-action compact" type="button" onClick={() => {
                const requestId = failedOpenRequest.requestId
                void FastViewerFiles.discardOpenRequest({ requestId }).then(() => {
                  setFailedOpenRequest(null)
                  drainOpenQueueRef.current()
                }).catch((error) => showToast(error instanceof Error ? error.message : '无法丢弃请求', 'warning'))
              }}>丢弃</button>
            </div>
          </section>
        </div>
      )}

      {returnDocumentId && view === 'reader' && returnDocumentId !== activeDocumentId && (
        <button className="return-document-toast" type="button" onClick={() => {
          const previous = documents.find((item) => item.id === returnDocumentId)
          setReturnDocumentId(null)
          if (previous) void openDocument(previous)
        }}>返回上一文档</button>
      )}

      {toast && (
        <div className={`toast ${toast.tone ?? 'normal'}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      )}

      {commandPaletteOpen && (
        <CommandPalette
          commands={desktopCommands}
          query={commandQuery}
          onQuery={setCommandQuery}
          onClose={() => { setCommandPaletteOpen(false); setCommandQuery('') }}
        />
      )}
    </div>
  )
}

export default App
