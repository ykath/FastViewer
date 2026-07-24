import {
  AlertCircle,
  Archive,
  BookOpen,
  ChevronLeft,
  Copy,
  FileCode2,
  FileText,
  FolderOpen,
  Heart,
  Home,
  ImageDown,
  ListTree,
  Loader2,
  Menu,
  Moon,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Sun,
  Type,
  Upload,
  X,
} from 'lucide-react'
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { Share } from '@capacitor/share'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { decodeWithEncoding, base64ToBytes, ENCODING_OPTIONS } from './encoding'
import type { EncodingLabel } from './encoding'
import type { DocumentRecord, DocumentType } from './document-types'
import { useDocumentStore } from './use-document-store'
import { finishPerformanceSpan, startPerformanceSpan } from './performance-metrics'
import { decodeDocumentBytes } from './decode-document'
import { buildSafeHtmlDocument, extractMarkdownHeadings, rewriteRelativeResources } from './html-processing'
import type { HeadingItem, HtmlRenderInfo } from './html-processing'
import { DEFAULT_READER_SETTINGS, nextThemePreference, themePreferenceLabel } from './reader-settings'
import type { ReaderSettings, ThemeMode } from './reader-settings'
import { desktopPlatform } from './desktop-platform'
import type { DesktopOpenRequest } from './desktop-platform'
import './App.css'

const MarkdownReader = lazy(() => import('./MarkdownReader'))
const SettingsPage = lazy(() => import('./SettingsPage'))

type View = 'home' | 'reader' | 'settings' | 'error' | 'loading'
type HomeTab = 'recent' | 'favorite' | 'library'
type FileSortMode = 'recent' | 'name' | 'size'
type ReaderMode = 'rendered' | 'source'
type ImageExportMode = 'visible' | 'full' | 'pages'

type FileOpenErrorCode =
  | 'PERMISSION_EXPIRED'
  | 'FILE_NOT_FOUND'
  | 'NO_VIEWABLE_FILE'
  | 'UNSUPPORTED_TYPE'
  | 'ENCODING_FAILED'
  | 'FILE_TOO_LARGE'
  | 'ARCHIVE_FAILED'
  | 'RENDER_FAILED'
  | 'UNKNOWN'

type FileOpenError = {
  code: FileOpenErrorCode
  message: string
}

const FILE_SIZE_WARNING = 5 * 1024 * 1024
const FILE_SIZE_DANGER = 10 * 1024 * 1024

type ToastState = {
  message: string
  tone?: 'normal' | 'success' | 'warning'
}

type ExternalFileResult = {
  hasFile?: boolean
  isArchive?: boolean
  uri?: string
  fileName?: string
  mimeType?: string
  base64Content?: string
  cachedPath?: string
  storageId?: string
  content?: string
  size?: number
  error?: string
  errorCode?: string
  documents?: ExternalArchiveDocument[]
  resources?: Record<string, string | ExternalArchiveResource>
}

type ExternalArchiveDocument = {
  fileName: string
  relativePath?: string
  archiveName?: string
  sourceUri?: string
  base64Content?: string
  cachedPath?: string
  size?: number
}

type ExternalArchiveResource = {
  mimeType?: string
  path: string
  size?: number
}

type NativeFileChunk = {
  base64Content: string
  bytesRead: number
  done: boolean
  size: number
}

type FastViewerFilesPlugin = {
  getLaunchFile: () => Promise<ExternalFileResult>
  pickFile: () => Promise<ExternalFileResult>
  importArchive: (options: {
    fileName: string
    base64Content: string
    mimeType?: string
    size?: number
  }) => Promise<ExternalFileResult>
  readFileChunk: (options: { path: string; offset: number; length?: number }) => Promise<NativeFileChunk>
  releaseStoredFile: (options: { path: string }) => Promise<{ deleted: boolean }>
  releaseArchive: (options: { storageId: string }) => Promise<{ deleted: boolean }>
  cleanupArchives: (options: { storageIds: string[] }) => Promise<{ deleted: number }>
  createPdf: (options: { title: string; content: string }) => Promise<{
    uri: string
    path: string
    size: number
    pageCount: number
  }>
  selectResourceDirectory: () => Promise<{
    storageId: string
    resources: Record<string, ExternalArchiveResource>
    count: number
  }>
  addListener: (
    eventName: 'fileOpen',
    listenerFunc: (result: ExternalFileResult) => void,
  ) => Promise<PluginListenerHandle>
}

const FastViewerFiles = registerPlugin<FastViewerFilesPlugin>('FastViewerFiles')

const SETTINGS_KEY = 'lightpage.settings.v1'

const sampleMarkdown = `# 手机端 Markdown / HTML 阅读器

轻页用于快速打开微信、文件管理器和邮箱中的 Markdown 与 HTML 文件，让移动端临时阅读、搜索和转发更顺手。

## 核心能力

- 直接打开 \`.md\`、\`.markdown\` 文件。
- 自动生成目录，并支持文内搜索和阅读位置恢复。
- 默认本地处理，文件内容不会上传。

> 外出时只需要看懂文件，不需要先折腾文件管理器或代码编辑器。

## 任务清单

- [x] 构建基础 App 壳
- [x] 实现 Markdown 阅读
- [ ] 接入 HTML 安全沙盒

## 表格示例

| 格式 | 当前状态 | 说明 |
| --- | --- | --- |
| Markdown | 已支持 | GFM、表格、任务列表 |
| HTML | 后续阶段 | M7 进入实现 |

## 代码示例

\`\`\`ts
const mode = file.fileType === 'markdown' ? 'reader' : 'sandbox'
console.log(mode)
\`\`\`
`

const seedDocuments: DocumentRecord[] = [
  createRecordFromContent({
    fileName: '会议纪要.md',
    content: sampleMarkdown,
    sourceType: '示例',
    isFavorite: true,
    inLibrary: true,
    lastOpenedAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  }),
  createRecordFromContent({
    fileName: 'AI 报告摘要.markdown',
    content:
      '# AI 报告摘要\n\n这是一份用于测试的 Markdown 文档。\n\n## 结论\n\n- 移动端阅读入口需要足够直接。\n- 文件内容默认本地处理更容易建立信任。\n',
    sourceType: '示例',
    inLibrary: true,
    lastOpenedAt: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(),
  }),
  {
    ...createRecordFromContent({
      fileName: '产品需求说明.html',
      content:
        '<!doctype html><html><head><title>产品需求说明</title><style>body{font-family:system-ui}</style></head><body><h1>产品需求说明</h1><p>这是一份 HTML 示例文档。</p><h2>能力范围</h2><table><tr><th>能力</th><th>状态</th></tr><tr><td>沙盒渲染</td><td>已启用</td></tr><tr><td>外部资源</td><td>默认阻止</td></tr></table><pre><code>console.log("script disabled")</code></pre><p><a href="https://example.com">外部链接示例</a></p><script>alert("blocked")</script></body></html>',
      sourceType: '示例',
      lastOpenedAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    }),
    fileType: 'html',
    fileExtension: 'html',
  },
]

function App() {
  const [view, setView] = useState<View>('home')
  const [activeTab, setActiveTab] = useState<HomeTab>('recent')
  const [documents, setDocuments, documentsHydrated] = usePersistentDocuments()
  const [activeDocumentId, setActiveDocumentId] = useState(documents[0]?.id ?? '')
  const [fileError, setFileError] = useState<FileOpenError | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [settings, setSettings] = usePersistentSettings()
  const [systemTheme, setSystemTheme] = useState<ThemeMode>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const [largeSizeConfirm, setLargeSizeConfirm] = useState<{ resolve: (v: boolean) => void; size: number } | null>(null)
  const [pasteDraft, setPasteDraft] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const archiveCleanupStartedRef = useRef(false)
  const isDesktop = desktopPlatform.isDesktop()

  const activeDocument = documents.find((doc) => doc.id === activeDocumentId) ?? documents[0]

  const resolvedTheme: ThemeMode = settings.themeMode === 'system' ? systemTheme : settings.themeMode

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return undefined
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    desktopPlatform.applyRuntimeMarker()
  }, [])

  useEffect(() => {
    if (!documentsHydrated || !Capacitor.isNativePlatform() || archiveCleanupStartedRef.current) return
    archiveCleanupStartedRef.current = true
    const storageIds = Array.from(new Set(documents.flatMap((item) => [item.archiveStorageId, item.resourceStorageId].filter(Boolean)))) as string[]
    void FastViewerFiles.cleanupArchives({ storageIds }).catch(() => undefined)
  }, [documents, documentsHydrated])

  useEffect(() => {
    resetViewportScroll()
  }, [view])

  useEffect(() => {
    if (!activeDocumentId && documents[0]) {
      setActiveDocumentId(documents[0].id)
    }
  }, [activeDocumentId, documents])

  const showToast = (message: string, tone: ToastState['tone'] = 'normal') => {
    setToast({ message, tone })
    window.setTimeout(() => setToast(null), 2200)
  }

  const showError = (code: FileOpenErrorCode, message: string) => {
    setFileError({ code, message })
    setView('error')
  }

  const persistDocuments = useCallback((updater: (items: DocumentRecord[]) => DocumentRecord[]) => {
    setDocuments((current) => {
      const next = updater(current)
      return sortDocuments(next)
    })
  }, [setDocuments])

  const openDocument = (doc: DocumentRecord) => {
    const openedAt = new Date().toISOString()
    persistDocuments((items) =>
      upsertDocument(items, { ...doc, lastOpenedAt: openedAt }),
    )
    setActiveDocumentId(doc.id)
    setView('reader')
    if (
      desktopPlatform.isDesktop()
      && doc.fileType === 'markdown'
      && doc.sourceUri
      && !doc.archiveResources
    ) {
      void desktopPlatform.loadMarkdownResources(doc.sourceUri, doc.content)
        .then((resources) => {
          if (Object.keys(resources).length === 0) return
          persistDocuments((items) =>
            upsertDocument(items, { ...doc, archiveResources: resources, lastOpenedAt: openedAt }),
          )
        })
        .catch(() => undefined)
    }
  }

  const importDocument = (doc: DocumentRecord, openAfterImport = true) => {
    persistDocuments((items) => upsertDocument(items, doc))
    setActiveDocumentId(doc.id)
    if (openAfterImport) {
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
  ) => {
    const result = await decodeDocumentBytes(bytes)
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

    const record = createRecordFromBytes({
      fileName,
      content: result.content,
      encoding: result.encoding,
      rawBase64,
      sourceType,
      sourceUri,
      fileSize: fileSize ?? bytes.length,
      archiveResources,
    })

    importDocument(record)
    finishPerformanceSpan('file-open', startedAt, { bytes: bytes.length, type: record.fileType })

    if (result.confidence === 'low') {
      showToast('编码识别置信度较低，可在编码设置中切换', 'warning')
    }

    const displayType = record.fileType === 'html' ? '已安全打开 HTML 文件' : '文件已打开'
    showToast(displayType, 'success')
  }

  const importDesktopRequest = async (request: DesktopOpenRequest) => {
    const startedAt = startPerformanceSpan()
    if (request.size >= FILE_SIZE_DANGER) {
      setView('loading')
      const action = await checkFileSizeAndConfirm(request.size)
      if (action === 'cancel') {
        setView('home')
        return
      }
    } else if (request.size >= FILE_SIZE_WARNING) {
      showToast(`文件较大（${formatBytes(request.size)}），渲染可能较慢`, 'warning')
    }

    setView('loading')
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
      )
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
    const archiveResources = Object.fromEntries(
      Object.entries(result.resources ?? {}).map(([key, resource]) => {
        if (typeof resource === 'string') return [key, resource]
        return [key, Capacitor.convertFileSrc(resource.path)]
      }),
    )
    const records: DocumentRecord[] = []
    for (let index = 0; index < archiveDocuments.length; index += 1) {
      const item = archiveDocuments[index]
      const bytes = item.cachedPath
        ? await readNativeStoredFile(item.cachedPath, item.size)
        : item.base64Content
          ? base64ToBytes(item.base64Content)
          : new Uint8Array()
      if (bytes.length === 0) continue
      const decoded = await decodeDocumentBytes(bytes)
      const record = createRecordFromBytes({
        fileName: item.relativePath ?? item.fileName,
        content: decoded.content,
        encoding: decoded.encoding,
        rawBase64: decoded.rawBase64,
        sourceType: `压缩包：${result.fileName ?? item.archiveName ?? '未知压缩包'}`,
        sourceUri: item.sourceUri ?? result.uri,
        fileSize: item.size ?? bytes.length,
        inLibrary: true,
        lastOpenedAt: new Date(importedAt - index).toISOString(),
        archiveRelativePath: item.relativePath,
        archiveResources,
        archiveStorageId: result.storageId,
      })
      records.push(record)
    }

    if (records.length === 0) {
      showError('NO_VIEWABLE_FILE', '压缩包中没有可读取的 Markdown 或 HTML 文件。')
      return
    }

    persistDocuments((items) => records.reduce((next, record) => upsertDocument(next, record), items))
    setActiveDocumentId(records[0].id)
    setView('reader')
    showToast(`已从压缩包导入 ${records.length} 个可查看文件`, 'success')
  }

  const importExternalResult = async (result: ExternalFileResult) => {
    if (result.error || result.errorCode) {
      const code = (result.errorCode as FileOpenErrorCode) || 'UNKNOWN'
      showError(code, result.error || '外部文件读取失败')
      return
    }

    if (!result.hasFile) return

    if (result.isArchive || result.documents?.length) {
      setView('loading')
      try {
        await importArchiveDocuments(result)
      } catch {
        showError('ARCHIVE_FAILED', '压缩包内容处理失败，请确认文件未损坏。')
      }
      return
    }

    // Backwards compat: if native sent base64Content, use new pipeline
    if (result.base64Content && result.fileName) {
      const size = result.size ?? 0

      if (size > 0 && size >= FILE_SIZE_DANGER) {
        setView('loading')
        const action = await checkFileSizeAndConfirm(size)
        if (action === 'cancel') {
          setView('home')
          return
        }
      } else if (size > 0 && size >= FILE_SIZE_WARNING) {
        showToast(`文件较大（${formatBytes(size)}），渲染可能较慢`, 'warning')
      }

      setView('loading')
      try {
        const bytes = base64ToBytes(result.base64Content)
        await processBytes(bytes, result.fileName, '外部应用', result.uri, result.size)
      } catch {
        showError('UNKNOWN', '文件解码失败，请尝试重新打开。')
      }
      return
    }

    if (result.cachedPath && result.fileName) {
      const size = result.size ?? 0
      if (size > 0 && size >= FILE_SIZE_DANGER) {
        setView('loading')
        const action = await checkFileSizeAndConfirm(size)
        if (action === 'cancel') {
          await FastViewerFiles.releaseStoredFile({ path: result.cachedPath }).catch(() => undefined)
          setView('home')
          return
        }
      } else if (size > 0 && size >= FILE_SIZE_WARNING) {
        showToast(`文件较大（${formatBytes(size)}），渲染可能较慢`, 'warning')
      }

      setView('loading')
      try {
        const bytes = await readNativeStoredFile(result.cachedPath, result.size)
        await processBytes(bytes, result.fileName, '外部应用', result.uri, result.size)
      } catch {
        showError('UNKNOWN', '文件分块读取失败，请尝试重新打开。')
      } finally {
        await FastViewerFiles.releaseStoredFile({ path: result.cachedPath }).catch(() => undefined)
      }
      return
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
    }
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
    void loadExternalLaunchFile()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isDesktop) return undefined
    let disposed = false
    let unlisten: (() => void) | undefined

    void desktopPlatform.listenForOpenRequests(importDesktopRequest).then(async (removeListener) => {
      if (disposed) {
        removeListener()
        return
      }
      unlisten = removeListener
      const pending = await desktopPlatform.takePendingOpenRequests()
      for (const request of pending) {
        if (disposed) break
        await importDesktopRequest(request)
      }
    }).catch((error) => {
      if (!disposed) showError('UNKNOWN', error instanceof Error ? error.message : 'Windows 文件关联初始化失败')
    })

    return () => {
      disposed = true
      unlisten?.()
    }
    // The desktop bridge owns event serialization and is initialized once per app mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined

    let handle: PluginListenerHandle | undefined
    void FastViewerFiles.addListener('fileOpen', (result) => {
      void importExternalResult(result)
    }).then((listenerHandle) => {
      handle = listenerHandle
    })

    return () => {
      void handle?.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const deleteDocument = (doc: DocumentRecord) => {
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

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".md,.markdown,.mdown,.html,.htm,.xhtml,.zip,.rar,text/markdown,text/html,application/zip,application/x-zip-compressed,application/vnd.rar,application/x-rar-compressed"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handlePickedFile(file)
        }}
      />

      <main className="app-main">
        {view === 'home' && (
          <HomePage
            activeTab={activeTab}
            documents={documents}
            onTabChange={setActiveTab}
            onOpenFile={openDocument}
            onPickFile={() => { void openFilePicker() }}
            onPasteOpen={() => { void openPasteDialog() }}
            onDelete={deleteDocument}
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
              persistDocuments((items) =>
                items.map((item) =>
                  item.id === doc.id ? { ...item, isFavorite: !item.isFavorite } : item,
                ),
              )
            }
          />
        )}

        {view === 'reader' && activeDocument && (
          <ReaderPage
            document={activeDocument}
            settings={settings}
            resolvedTheme={resolvedTheme}
            onBack={() => setView('home')}
            onUpdate={updateActiveDocument}
            onShowToast={showToast}
            onSetSettings={setSettings}
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
        onNavigate={(nextView) => {
          if (nextView === 'reader' && !activeDocument) return
          if (nextView === 'loading') return
          setView(nextView)
        }}
      />

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

      {toast && (
        <div className={`toast ${toast.tone ?? 'normal'}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  )
}

type HomePageProps = {
  activeTab: HomeTab
  documents: DocumentRecord[]
  onTabChange: (tab: HomeTab) => void
  onOpenFile: (doc: DocumentRecord) => void
  onPickFile: () => void
  onPasteOpen: () => void
  onDelete: (doc: DocumentRecord) => void
  onClearTab: (tab: HomeTab) => void
  onToggleFavorite: (doc: DocumentRecord) => void
}

function HomePage({
  activeTab,
  documents,
  onTabChange,
  onOpenFile,
  onPickFile,
  onPasteOpen,
  onDelete,
  onClearTab,
  onToggleFavorite,
}: HomePageProps) {
  const [query, setQuery] = useState('')
  const [debouncedLibraryQuery, setDebouncedLibraryQuery] = useState('')
  const [sortMode, setSortMode] = useState<FileSortMode>('recent')
  const [visibleCount, setVisibleCount] = useState(50)
  const files = useMemo(() => {
    const normalizedQuery = debouncedLibraryQuery.trim().toLocaleLowerCase()
    const filtered = documents.filter((doc) => {
      if (activeTab === 'favorite' && !doc.isFavorite) return false
      if (activeTab === 'library' && !doc.inLibrary) return false
      return !normalizedQuery
        || doc.fileName.toLocaleLowerCase().includes(normalizedQuery)
        || doc.content.toLocaleLowerCase().includes(normalizedQuery)
    })
    return filtered.sort((left, right) => {
      if (sortMode === 'name') return left.fileName.localeCompare(right.fileName, 'zh-CN')
      if (sortMode === 'size') return right.fileSize - left.fileSize
      return right.lastOpenedAt.localeCompare(left.lastOpenedAt)
    })
  }, [activeTab, debouncedLibraryQuery, documents, sortMode])
  const storageSize = useMemo(
    () => documents.reduce((total, document) => total + document.fileSize, 0),
    [documents],
  )

  useEffect(() => {
    setVisibleCount(50)
  }, [activeTab, debouncedLibraryQuery, sortMode])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedLibraryQuery(query), 180)
    return () => window.clearTimeout(timer)
  }, [query])

  const clearLabel = activeTab === 'favorite' ? '清空收藏' : activeTab === 'library' ? '移出文件库' : '清理未收藏记录'

  return (
    <section className="page page-home" aria-label="轻页首页">
      <header className="home-header">
        <div>
          <p className="eyebrow">LightPage</p>
          <h1>轻页</h1>
          <p className="home-subtitle">Markdown / HTML 阅读器</p>
        </div>
        <span className="file-count">{documents.length} 个文件</span>
      </header>

      <section className="quick-actions" aria-label="打开方式">
        <button className="primary-action" type="button" onClick={onPickFile}>
          <FolderOpen size={20} />
          <span>打开文件</span>
        </button>
        <button className="secondary-action" type="button" onClick={onPasteOpen}>
          <Copy size={19} />
          <span>粘贴打开</span>
        </button>
      </section>

      <div className="local-note">
        <ShieldCheck size={16} />
        <span>文件默认仅在本机处理，不上传内容。</span>
      </div>

      <nav className="segmented" aria-label="文件分类">
        <button
          className={activeTab === 'recent' ? 'active' : ''}
          type="button"
          onClick={() => onTabChange('recent')}
        >
          最近
        </button>
        <button
          className={activeTab === 'favorite' ? 'active' : ''}
          type="button"
          onClick={() => onTabChange('favorite')}
        >
          收藏
        </button>
        <button
          className={activeTab === 'library' ? 'active' : ''}
          type="button"
          onClick={() => onTabChange('library')}
        >
          文件库
        </button>
      </nav>

      <section className="library-tools" aria-label="文件筛选和存储管理">
        <label className="library-search">
          <Search size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件名或正文"
            aria-label="搜索文件名或正文"
          />
        </label>
        <select
          className="library-sort"
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value as FileSortMode)}
          aria-label="文件排序"
        >
          <option value="recent">最近打开</option>
          <option value="name">文件名</option>
          <option value="size">文件大小</option>
        </select>
      </section>

      <div className="library-summary">
        <span>{files.length} 个结果 · 本地内容约 {formatBytes(storageSize)}</span>
        {documents.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`确定要${clearLabel}吗？此操作只影响本机记录。`)) onClearTab(activeTab)
            }}
          >
            {clearLabel}
          </button>
        )}
      </div>

      <section className="file-list" aria-label="文件列表">
        {files.length === 0 ? (
          <EmptyState tab={activeTab} />
        ) : (
          files.slice(0, visibleCount).map((file) => (
            <article className="file-row" key={file.id}>
              <button className="file-open-button" type="button" onClick={() => onOpenFile(file)}>
                <span className={`file-icon ${file.fileType}`}>
                  {file.fileType === 'markdown' ? (
                    <FileText size={20} />
                  ) : (
                    <FileCode2 size={20} />
                  )}
                </span>
                <span className="file-main">
                  <span className="file-name">{file.fileName}</span>
                  <span className="file-meta">
                    {file.sourceType} · {formatBytes(file.fileSize)} · {formatTime(file.lastOpenedAt)}
                  </span>
                </span>
                <span className="file-kind">{file.fileExtension.toUpperCase()}</span>
              </button>
              <div className="file-row-actions">
                <button
                  className={file.isFavorite ? 'row-action active' : 'row-action'}
                  type="button"
                  aria-label={file.isFavorite ? '取消收藏' : '收藏'}
                  onClick={() => onToggleFavorite(file)}
                >
                  <Star size={16} />
                </button>
                <button
                  className="row-action"
                  type="button"
                  aria-label="删除"
                  onClick={() => onDelete(file)}
                >
                  <X size={16} />
                </button>
              </div>
            </article>
          ))
        )}
        {visibleCount < files.length && (
          <button className="load-more" type="button" onClick={() => setVisibleCount((count) => count + 50)}>
            再加载 50 个
          </button>
        )}
      </section>
    </section>
  )
}

type ReaderPageProps = {
  document: DocumentRecord
  settings: ReaderSettings
  resolvedTheme: ThemeMode
  onBack: () => void
  onUpdate: (patch: Partial<DocumentRecord>) => void
  onShowToast: (message: string, tone?: ToastState['tone']) => void
  onSetSettings: (settings: ReaderSettings) => void
}

function ReaderPage({
  document,
  settings,
  resolvedTheme,
  onBack,
  onUpdate,
  onShowToast,
  onSetSettings,
}: ReaderPageProps) {
  const isDesktop = desktopPlatform.isDesktop()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchCount, setSearchCount] = useState(0)
  const [tocOpen, setTocOpen] = useState(false)
  const [desktopTocOpen, setDesktopTocOpen] = useState(true)
  const [tocQuery, setTocQuery] = useState('')
  const [tocExpanded, setTocExpanded] = useState(true)
  const [activeHeadingId, setActiveHeadingId] = useState(document.lastReadHeadingId ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  const [readerToolsOpen, setReaderToolsOpen] = useState(false)
  const [encodingOpen, setEncodingOpen] = useState(false)
  const [htmlPermissionsOpen, setHtmlPermissionsOpen] = useState(false)
  const [imageExportOpen, setImageExportOpen] = useState(false)
  const [readerMode, setReaderMode] = useState<ReaderMode>(
    document.fileSize >= FILE_SIZE_DANGER ? 'source' : 'rendered',
  )
  const [renderFailed, setRenderFailed] = useState(false)
  const [allowExternalOnce, setAllowExternalOnce] = useState(false)
  const [htmlFrameVersion, setHtmlFrameVersion] = useState(0)
  const contentRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const searchMatchesRef = useRef<HTMLElement[]>([])
  const htmlResizeCleanupRef = useRef<(() => void) | null>(null)
  const activeDocumentIdRef = useRef<string | null>(null)
  const readPositionTimerRef = useRef<number | null>(null)
  const headingFrameRef = useRef<number | null>(null)
  const pendingReadPositionRef = useRef<{ top: number; progress: number; headingId?: string } | null>(null)
  const edgeSwipeRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
  })
  const handleOpenExternalLink = useCallback((url: string) => {
    void desktopPlatform.openExternalLink(url)
  }, [])

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
    setActiveHeadingId(document.lastReadHeadingId ?? '')
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
      if (document.lastReadHeadingId) {
        let target: HTMLElement | null | undefined
        try {
          target = document.fileType === 'html'
            ? iframeRef.current?.contentDocument?.getElementById(document.lastReadHeadingId)
            : window.document.getElementById(document.lastReadHeadingId)
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
  }, [document.fileSize, document.fileType, document.id, document.lastReadHeadingId, document.lastReadPosition, document.lastReadProgress])

  const getSearchContainer = useCallback(() => {
    if (document.fileType === 'html') {
      try {
        return iframeRef.current?.contentDocument?.body ?? null
      } catch {
        return null
      }
    }

    return contentRef.current
  }, [document.fileType])

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
      characters: document.content.length,
      matches: matches.length,
    })
    searchMatchesRef.current = matches
    setSearchCount(matches.length)
    setSearchIndex(0)
  }, [debouncedQuery, getSearchContainer, readerMode, document.content, htmlFrameVersion, htmlInfo?.srcDoc])

  useEffect(() => {
    searchMatchesRef.current.forEach((match, index) => {
      match.classList.toggle('active', index === searchIndex)
    })
    searchMatchesRef.current[searchIndex]?.scrollIntoView({ block: 'center' })
  }, [searchIndex, searchCount])

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

  const toggleFavorite = () => {
    onUpdate({ isFavorite: !document.isFavorite })
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

  const nextSearchResult = (delta: number) => {
    if (searchCount === 0) return
    setSearchIndex((current) => (current + delta + searchCount) % searchCount)
  }

  const closeTopReaderLayer = useCallback(() => {
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

    return false
  }, [encodingOpen, htmlPermissionsOpen, menuOpen, readerToolsOpen, searchOpen, tocOpen])

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

  const handleEdgePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, a, .search-panel, .reader-toolbar, .html-frame')) return

    edgeSwipeRef.current = {
      active: event.clientX <= 28,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    }
  }

  const handleEdgePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!edgeSwipeRef.current.active) return
    edgeSwipeRef.current.lastX = event.clientX
    edgeSwipeRef.current.lastY = event.clientY
  }

  const handleEdgePointerUp = () => {
    const swipe = edgeSwipeRef.current
    if (!swipe.active) return

    const deltaX = swipe.lastX - swipe.startX
    const deltaY = Math.abs(swipe.lastY - swipe.startY)
    edgeSwipeRef.current.active = false

    if (deltaX >= 76 && deltaY <= 54) {
      if (closeTopReaderLayer()) return
      onBack()
    }
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

  const [exporting, setExporting] = useState(false)

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

  const shareOriginalFile = async () => {
    if (exporting) return
    setExporting(true)
    setMenuOpen(false)
    try {
      if (isDesktop) {
        const bytes = document.rawBase64
          ? base64ToBytes(document.rawBase64)
          : new TextEncoder().encode(document.content)
        const saved = await desktopPlatform.saveOriginal(bytes, document.fileName)
        if (saved) onShowToast('原文件已导出', 'success')
        return
      }
      if (!Capacitor.isNativePlatform()) {
        const blob = document.rawBase64
          ? new Blob([base64ToBytes(document.rawBase64).buffer as ArrayBuffer], { type: inferDocumentMime(document) })
          : new Blob([document.content], { type: 'text/plain;charset=utf-8' })
        const a = window.document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = document.fileName
        a.click()
        URL.revokeObjectURL(a.href)
        onShowToast('已下载文件', 'success')
        return
      }

      const path = `share/${document.fileName}`
      if (document.rawBase64) {
        await Filesystem.writeFile({ path, data: document.rawBase64, directory: Directory.Cache, recursive: true })
      } else {
        await Filesystem.writeFile({ path, data: document.content, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
      }

      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
      await Share.share({ title: document.fileName, url: uri, dialogTitle: '分享文件' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      if (!msg.includes('cancel') && !msg.includes('dismiss')) {
        onShowToast(`分享失败：${msg}`, 'warning')
      }
    } finally {
      setExporting(false)
    }
  }

  const exportPdf = async () => {
    if (exporting) return
    setExporting(true)
    setMenuOpen(false)
    const exportStartedAt = startPerformanceSpan()
    try {
      if (Capacitor.isNativePlatform()) {
        const content = document.fileType === 'html' && htmlInfo
          ? htmlInfo.plainText
          : document.content
        const result = await FastViewerFiles.createPdf({ title: document.fileName, content })
        await Share.share({
          title: `${document.fileName} PDF`,
          files: [result.uri],
          dialogTitle: '分享 PDF',
        })
        onShowToast(`PDF 已生成（${result.pageCount} 页）`, 'success')
        finishPerformanceSpan('pdf-export', exportStartedAt, { pages: result.pageCount, bytes: result.size })
        return
      }

      let printHtml: string
      if (document.fileType === 'html' && htmlInfo) {
        printHtml = htmlInfo.srcDoc.replace('</head>', `${PRINT_CSS}</head>`)
      } else {
        const rendered = contentRef.current?.innerHTML ?? `<pre>${escapeHtml(document.content)}</pre>`
        printHtml = buildPrintDocument(document.fileName, rendered)
      }

      const printFrame = window.document.createElement('iframe')
      printFrame.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px;'
      window.document.body.appendChild(printFrame)

      const frameDoc = printFrame.contentDocument ?? printFrame.contentWindow?.document
      if (!frameDoc) throw new Error('无法创建打印窗口')

      frameDoc.open()
      frameDoc.write(printHtml)
      frameDoc.close()

      await new Promise<void>((resolve) => {
        printFrame.onload = () => resolve()
        setTimeout(resolve, 1500)
      })

      printFrame.contentWindow?.print()
      setTimeout(() => printFrame.remove(), 3000)
      onShowToast('已调起浏览器打印/PDF 导出', 'success')
      finishPerformanceSpan('pdf-export', exportStartedAt, { browserPrint: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      onShowToast(`PDF 导出失败：${msg}`, 'warning')
    } finally {
      setExporting(false)
    }
  }

  const shareAsImage = async (mode: ImageExportMode) => {
    if (exporting) return
    setExporting(true)
    setMenuOpen(false)
    const exportStartedAt = startPerformanceSpan()
    try {
      let targetElement: HTMLElement | null = null
      let canvas: HTMLCanvasElement

      if (document.fileType === 'html') {
        if (allowScripts) {
          const exportHtml = buildSafeHtmlDocument(
            document.archiveResources
              ? rewriteRelativeResources(document.content, document.fileName, document.archiveRelativePath, document.archiveResources)
              : document.content,
            { allowExternalResources, allowScripts: false, allowForms: false },
          )
          canvas = await captureHtmlSourceAsCanvas(exportHtml.srcDoc, resolvedTheme)
        } else {
          canvas = await captureHtmlFrameAsCanvas(iframeRef.current, resolvedTheme)
        }
      } else {
        targetElement = contentRef.current

        if (!targetElement) throw new Error('无法获取内容区域')

        const { default: html2canvas } = await import('html2canvas-pro')
        const width = Math.ceil(targetElement.getBoundingClientRect().width || 375)
        const height = Math.max(targetElement.scrollHeight, Math.ceil(targetElement.getBoundingClientRect().height))
        canvas = await html2canvas(targetElement, {
          useCORS: true,
          scale: calculateExportScale(width, height),
          backgroundColor: resolvedTheme === 'dark' ? '#171e1a' : '#fffdf8',
          windowWidth: width,
        })
      }

      let outputCanvases = [canvas]
      if (mode === 'visible') {
        const scroller = scrollRef.current
        const viewportRatio = scroller ? Math.min(1, scroller.clientHeight / Math.max(1, scroller.scrollHeight)) : 1
        const progress = scroller ? scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight) : 0
        const cropHeight = Math.max(1, Math.round(canvas.height * viewportRatio))
        const cropTop = Math.round((canvas.height - cropHeight) * clamp(progress, 0, 1))
        outputCanvases = [cropCanvas(canvas, cropTop, cropHeight)]
      } else if (mode === 'pages') {
        outputCanvases = paginateCanvas(canvas)
      }

      if (!Capacitor.isNativePlatform()) {
        if (isDesktop) {
          const baseName = document.fileName.replace(/\.[^.]+$/, '')
          const imageFiles = await Promise.all(outputCanvases.map(async (outputCanvas, index) => ({
            fileName: `${baseName}${outputCanvases.length > 1 ? `-${index + 1}` : ''}.png`,
            bytes: await canvasToPngBytes(outputCanvas),
          })))
          const saved = await desktopPlatform.saveImages(imageFiles)
          if (!saved) return
          finishPerformanceSpan('image-export', exportStartedAt, {
            mode,
            pages: outputCanvases.length,
            pixels: outputCanvases.reduce((total, item) => total + item.width * item.height, 0),
          })
          onShowToast(`已导出 ${outputCanvases.length} 张图片`, 'success')
          return
        }
        outputCanvases.forEach((outputCanvas, index) => {
          const a = window.document.createElement('a')
          a.href = outputCanvas.toDataURL('image/png')
          a.download = `${document.fileName.replace(/\.[^.]+$/, '')}${outputCanvases.length > 1 ? `-${index + 1}` : ''}.png`
          a.click()
        })
        finishPerformanceSpan('image-export', exportStartedAt, {
          mode,
          pages: outputCanvases.length,
          pixels: outputCanvases.reduce((total, item) => total + item.width * item.height, 0),
        })
        onShowToast(`已下载 ${outputCanvases.length} 张图片`, 'success')
        return
      }

      const uris: string[] = []
      for (let index = 0; index < outputCanvases.length; index += 1) {
        const suffix = outputCanvases.length > 1 ? `-${index + 1}` : ''
        const imgPath = `share/${document.fileName.replace(/\.[^.]+$/, '')}${suffix}.png`
        const base64Data = outputCanvases[index].toDataURL('image/png').split(',')[1]
        await Filesystem.writeFile({ path: imgPath, data: base64Data, directory: Directory.Cache, recursive: true })
        const { uri } = await Filesystem.getUri({ path: imgPath, directory: Directory.Cache })
        uris.push(uri)
      }
      await Share.share({ title: `${document.fileName} 图片`, files: uris, dialogTitle: '分享图片' })
      finishPerformanceSpan('image-export', exportStartedAt, {
        mode,
        pages: outputCanvases.length,
        pixels: outputCanvases.reduce((total, item) => total + item.width * item.height, 0),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      if (!msg.includes('cancel') && !msg.includes('dismiss')) {
        onShowToast(`图片生成失败：${msg}`, 'warning')
      }
    } finally {
      setExporting(false)
    }
  }

  const statusText =
    document.lastReadPosition > 0 ? '已恢复阅读位置' : '从顶部开始'

  const handleHtmlFrameLoad = () => {
    const iframe = iframeRef.current
    if (!iframe) return
    let frameDocument: Document | null = null
    try {
      frameDocument = iframe?.contentDocument ?? null
    } catch {
      // Script mode intentionally uses an isolated origin, so parent DOM access is unavailable.
    }
    if (!frameDocument) return

    htmlResizeCleanupRef.current?.()
    iframe.style.height = ''

    let resizeFrameId: number | null = null
    const resizeFrameNow = () => {
      resizeFrameId = null
      const frameTop = Math.max(0, iframe.getBoundingClientRect().top)
      const availableHeight = Math.max(0, window.document.documentElement.clientHeight - frameTop)
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
          const href = element.dataset.externalHref ?? element.href
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
    try {
      if (document.fileType === 'html') {
        iframeRef.current?.contentDocument?.getElementById(heading.id)?.scrollIntoView({ block: 'start' })
      } else {
        window.document.getElementById(heading.id)?.scrollIntoView({ block: 'start' })
      }
    } catch {
      onShowToast('脚本隔离模式下无法定位目录，请暂时关闭脚本权限', 'warning')
    }
    setActiveHeadingId(heading.id)
    onUpdate({ lastReadHeadingId: heading.id })
    if (closeMobileDirectory) setTocOpen(false)
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
          {visibleHeadings.map((heading) => (
            <button
              key={heading.id}
              className={`toc-item level-${heading.level}${activeHeadingId === heading.id ? ' active' : ''}`}
              type="button"
              onClick={() => jumpToHeading(heading, closeMobileDirectory)}
            >
              {heading.text}
            </button>
          ))}
        </div>
      )}
    </>
  )

  const renderFileMenuActions = () => (
    <div className="menu-list">
      <MenuAction icon={<Archive size={18} />} label="保存到文件库" onClick={() => { setMenuOpen(false); saveToLibrary() }} />
      <MenuAction
        icon={<Heart size={18} />}
        label={document.isFavorite ? '取消收藏' : '收藏'}
        onClick={() => { setMenuOpen(false); toggleFavorite() }}
      />
      <MenuAction
        icon={<FileCode2 size={18} />}
        label={readerMode === 'source' ? '查看阅读视图' : '查看源码'}
        onClick={() => {
          setMenuOpen(false)
          setReaderMode(readerMode === 'source' ? 'rendered' : 'source')
        }}
      />
      <MenuAction icon={<Copy size={18} />} label="复制全文" onClick={() => { setMenuOpen(false); void copyText() }} />
      {document.fileType === 'html' && (
        <MenuAction
          icon={<ShieldCheck size={18} />}
          label="HTML 权限"
          onClick={() => {
            setMenuOpen(false)
            setHtmlPermissionsOpen(true)
          }}
        />
      )}
      <MenuAction
        icon={<Type size={18} />}
        label="编码设置"
        onClick={() => { setMenuOpen(false); setEncodingOpen(true) }}
      />
      <MenuAction icon={<Upload size={18} />} label={exporting ? '导出中...' : '导出 PDF'} onClick={() => { void exportPdf() }} />
      <MenuAction
        icon={<ImageDown size={18} />}
        label={exporting ? '生成中...' : '分享图片'}
        onClick={() => { setMenuOpen(false); setImageExportOpen(true) }}
      />
      <MenuAction
        icon={<Share2 size={18} />}
        label={exporting ? (isDesktop ? '导出中...' : '分享中...') : (isDesktop ? '导出原文件' : '分享原文件')}
        onClick={() => { void shareOriginalFile() }}
      />
    </div>
  )

  return (
    <section
      className={`page page-reader document-${document.fileType}${desktopTocOpen ? '' : ' desktop-toc-collapsed'} font-level-${settings.fontSizeLevel} line-level-${settings.lineHeightLevel} width-level-${settings.contentWidthLevel} code-level-${settings.codeSizeLevel}`}
      aria-label="文件阅读页"
      ref={scrollRef}
      onScroll={scheduleReadPositionSave}
      onPointerDown={handleEdgePointerDown}
      onPointerMove={handleEdgePointerMove}
      onPointerUp={handleEdgePointerUp}
      onPointerCancel={() => {
        edgeSwipeRef.current.active = false
      }}
    >
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
            <span>章节</span>
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

      <aside className="desktop-toc desktop-only" aria-label="章节目录">
        <header className="desktop-toc-header">
          <div>
            <span>章节</span>
            <small>{headings.length} 个标题</small>
          </div>
          <button className="icon-button" type="button" onClick={() => setDesktopTocOpen(false)} aria-label="收起章节">
            <X size={17} />
          </button>
        </header>
        <div className="desktop-toc-content">
          {renderTableOfContents(false)}
        </div>
      </aside>

      <div className="reader-document-pane">

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
          fallback={
            <div>
              <div className="render-fallback-notice">
                <AlertCircle size={16} />
                <span>渲染异常，已切换纯文本视图</span>
                <button type="button" onClick={() => setRenderFailed(false)}>重试</button>
              </div>
              <pre className="source-view">{document.content}</pre>
            </div>
          }
          onError={() => {
            setRenderFailed(true)
            onShowToast('渲染异常，已切换纯文本视图', 'warning')
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
            />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        <TextReader content={document.content} />
      )}

      </div>

      <div className={`reader-toolbar${readerToolsOpen ? ' open' : ''}`} aria-label="阅读工具">
        <div className="reader-tool-menu" aria-hidden={!readerToolsOpen}>
          <button type="button" onClick={toggleTheme} tabIndex={readerToolsOpen ? 0 : -1}>
            {resolvedTheme === 'light' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{themePreferenceLabel(settings.themeMode)}</span>
          </button>
          <button type="button" onClick={() => changeFontSize(-1)} tabIndex={readerToolsOpen ? 0 : -1}>
            <SlidersHorizontal size={18} />
            <span>A-</span>
          </button>
          <button type="button" onClick={() => changeFontSize(1)} tabIndex={readerToolsOpen ? 0 : -1}>
            <SlidersHorizontal size={18} />
            <span>A+</span>
          </button>
          <button type="button" onClick={copyText} tabIndex={readerToolsOpen ? 0 : -1}>
            <Copy size={18} />
            <span>复制</span>
          </button>
        </div>
        <button
          className="reader-tool-toggle"
          type="button"
          onClick={() => setReaderToolsOpen((open) => !open)}
          aria-expanded={readerToolsOpen}
          aria-label={readerToolsOpen ? '收起阅读工具' : '展开阅读工具'}
        >
          {readerToolsOpen ? <X size={20} /> : <SlidersHorizontal size={20} />}
        </button>
      </div>

      {tocOpen && (
        <div className="mobile-only mobile-directory-sheet">
          <Sheet title="目录" onClose={() => setTocOpen(false)}>
            {renderTableOfContents(true)}
          </Sheet>
        </div>
      )}

      {menuOpen && (
        <>
          <div className="mobile-only mobile-file-menu">
            <Sheet title="文件操作" onClose={() => setMenuOpen(false)}>
              {renderFileMenuActions()}
            </Sheet>
          </div>
          <DesktopPopover title="文件操作" position={menuPosition} onClose={() => setMenuOpen(false)}>
            {renderFileMenuActions()}
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
    </section>
  )
}

function TextReader({ content }: { content: string }) {
  return <pre className="source-view">{content}</pre>
}

function HtmlReader({
  iframeRef,
  info,
  scriptsEnabled,
  formsEnabled,
  onFrameLoad,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  info: HtmlRenderInfo
  scriptsEnabled: boolean
  formsEnabled: boolean
  onFrameLoad: () => void
}) {
  const sandbox = [
    scriptsEnabled ? 'allow-scripts' : 'allow-same-origin',
    formsEnabled ? 'allow-forms' : '',
  ].filter(Boolean).join(' ')
  return (
    <div className="html-reader">
      <iframe
        ref={iframeRef}
        className={`html-frame${scriptsEnabled ? ' isolated' : ''}`}
        title="HTML 阅读视图"
        sandbox={sandbox}
        srcDoc={info.srcDoc}
        scrolling={scriptsEnabled ? 'yes' : 'no'}
        onLoad={onFrameLoad}
      />
    </div>
  )
}

const ERROR_TITLES: Record<FileOpenErrorCode, string> = {
  NO_VIEWABLE_FILE: '压缩包无可查看文件',
  ARCHIVE_FAILED: '压缩包处理失败',
  PERMISSION_EXPIRED: '文件权限已失效',
  FILE_NOT_FOUND: '文件未找到',
  UNSUPPORTED_TYPE: '不支持的文件类型',
  ENCODING_FAILED: '编码识别失败',
  FILE_TOO_LARGE: '文件过大',
  RENDER_FAILED: '渲染失败',
  UNKNOWN: '暂时无法打开',
}

const ERROR_HINTS: Record<FileOpenErrorCode, string> = {
  NO_VIEWABLE_FILE: '压缩包中没有 .md、.markdown、.html 或 .htm 文件，解压目录已自动清理。',
  ARCHIVE_FAILED: '压缩包可能已损坏、被加密，或 RAR 格式版本暂不兼容。',
  PERMISSION_EXPIRED: '外部文件的访问权限已过期，请重新选择文件。',
  FILE_NOT_FOUND: '文件可能已被移动或删除。',
  UNSUPPORTED_TYPE: '当前版本仅支持 Markdown 和 HTML 文件。',
  ENCODING_FAILED: '无法识别文件编码，可尝试手动切换编码。',
  FILE_TOO_LARGE: '文件体积超出安全阈值，可能导致卡顿。',
  RENDER_FAILED: '文件内容解析异常，可查看源码或纯文本。',
  UNKNOWN: '文件读取失败，请确认文件格式和访问权限。',
}

function OpenErrorState({
  error,
  onBack,
  onPickFile,
}: {
  error: FileOpenError | null
  onBack: () => void
  onPickFile: () => void
}) {
  const code = error?.code ?? 'UNKNOWN'
  return (
    <section className="page page-error" aria-label="打开失败">
      <div className="error-panel">
        <span className="error-icon">
          <AlertCircle size={28} />
        </span>
        <h1>{ERROR_TITLES[code]}</h1>
        <p>{error?.message || ERROR_HINTS[code]}</p>
        <div className="error-actions">
          <button className="primary-action compact" type="button" onClick={onPickFile}>
            重新选择
          </button>
          <button className="secondary-action compact" type="button" onClick={onBack}>
            返回首页
          </button>
        </div>
      </div>
    </section>
  )
}

function LoadingState() {
  return (
    <section className="page page-loading" aria-label="加载中">
      <div className="loading-panel">
        <Loader2 size={32} className="loading-spinner" />
        <p>正在打开...</p>
      </div>
    </section>
  )
}

class RenderErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode; onError?: () => void },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch() { this.props.onError?.() }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

function EmptyState({ tab }: { tab: HomeTab }) {
  const copy =
    tab === 'favorite'
      ? '收藏常用文档后会出现在这里。'
      : tab === 'library'
        ? '保存到文件库后会出现在这里。'
        : '从微信或文件管理器打开后会出现在这里。'

  return (
    <div className="empty-state">
      <BookOpen size={24} />
      <p>这里还没有文件</p>
      <span>{copy}</span>
    </div>
  )
}

type BottomNavProps = {
  currentView: View
  hasReader: boolean
  onNavigate: (view: View) => void
}

function BottomNav({ currentView, hasReader, onNavigate }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <div className="desktop-nav-brand desktop-only" aria-hidden="true">
        <FileText size={21} />
        <span>轻页</span>
      </div>
      <button
        className={currentView === 'home' ? 'active' : ''}
        type="button"
        onClick={() => onNavigate('home')}
      >
        <Home size={20} />
        <span>首页</span>
      </button>
      <button
        className={currentView === 'reader' ? 'active' : ''}
        type="button"
        disabled={!hasReader}
        onClick={() => onNavigate('reader')}
      >
        <BookOpen size={20} />
        <span>阅读</span>
      </button>
      <button
        className={currentView === 'settings' ? 'active' : ''}
        type="button"
        onClick={() => onNavigate('settings')}
      >
        <Settings size={20} />
        <span>设置</span>
      </button>
    </nav>
  )
}

function DesktopPopover({
  title,
  position,
  children,
  onClose,
}: {
  title: string
  position: { x: number; y: number }
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="desktop-popover-layer desktop-only" role="presentation" onMouseDown={onClose}>
      <section
        className="desktop-popover"
        role="dialog"
        aria-modal="false"
        aria-label={title}
        style={{ left: position.x, top: position.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="desktop-popover-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

function Sheet({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

function PasteOpenDialog({
  value,
  onChange,
  onCancel,
  onConfirm,
}: {
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const html = looksLikeHtml(value)
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onCancel}>
      <section className="sheet paste-sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-header">
          <div>
            <h2>粘贴打开</h2>
            <p className="paste-detection">检测为 {html ? 'HTML' : 'Markdown / 纯文本'} · {value.length.toLocaleString()} 字符</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <textarea
          className="paste-input"
          value={value}
          autoFocus
          placeholder="在这里粘贴 Markdown 或 HTML 内容"
          onChange={(event) => onChange(event.target.value)}
        />
        {html && (
          <p className="sheet-description">HTML 将在严格沙盒中打开，脚本和外部资源默认禁用。</p>
        )}
        <div className="error-actions">
          <button className="primary-action compact" type="button" disabled={!value.trim()} onClick={onConfirm}>打开</button>
          <button className="secondary-action compact" type="button" onClick={onCancel}>取消</button>
        </div>
      </section>
    </div>
  )
}

function MenuAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button className="menu-action" type="button" onClick={onClick}>
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function PermissionToggle({
  title,
  description,
  enabled,
  onToggle,
}: {
  title: string
  description: string
  enabled: boolean
  onToggle: () => void
}) {
  return (
    <button className="permission-row" type="button" role="switch" aria-checked={enabled} onClick={onToggle}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`permission-switch${enabled ? ' enabled' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}

function usePersistentDocuments() {
  return useDocumentStore(seedDocuments)
}

function usePersistentSettings() {
  return usePersistentState<ReaderSettings>(SETTINGS_KEY, DEFAULT_READER_SETTINGS)
}

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return initialValue
      const parsed = JSON.parse(raw) as T
      if (parsed && initialValue && typeof parsed === 'object' && typeof initialValue === 'object'
        && !Array.isArray(parsed) && !Array.isArray(initialValue)) {
        return { ...initialValue, ...parsed }
      }
      return parsed
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue] as const
}

function createRecordFromBytes({
  fileName,
  content,
  encoding,
  rawBase64,
  sourceType,
  sourceUri,
  fileSize,
  isFavorite = false,
  inLibrary = false,
  lastOpenedAt,
  archiveRelativePath,
  archiveResources,
  archiveStorageId,
}: {
  fileName: string
  content: string
  encoding: string
  rawBase64?: string
  sourceType: string
  sourceUri?: string
  fileSize?: number
  isFavorite?: boolean
  inLibrary?: boolean
  lastOpenedAt?: string
  archiveRelativePath?: string
  archiveResources?: Record<string, string>
  archiveStorageId?: string
}): DocumentRecord {
  const extension = getExtension(fileName)
  const now = new Date().toISOString()

  return {
    id: stableDocumentId(fileName, content),
    fileName,
    fileExtension: extension || 'txt',
    fileType: inferFileType(fileName),
    fileSize: fileSize ?? new Blob([content]).size,
    sourceType,
    sourceUri,
    content,
    rawBase64,
    archiveRelativePath,
    archiveResources,
    archiveStorageId,
    encoding: encoding.toUpperCase(),
    lastOpenedAt: lastOpenedAt ?? now,
    createdAt: now,
    isFavorite,
    inLibrary,
    lastReadPosition: 0,
    lastReadProgress: 0,
  }
}

function createRecordFromContent({
  fileName,
  content,
  sourceType,
  sourceUri,
  fileSize,
  isFavorite = false,
  inLibrary = false,
  lastOpenedAt,
}: {
  fileName: string
  content: string
  sourceType: string
  sourceUri?: string
  fileSize?: number
  isFavorite?: boolean
  inLibrary?: boolean
  lastOpenedAt?: string
}): DocumentRecord {
  return createRecordFromBytes({
    fileName,
    content,
    encoding: 'utf-8',
    sourceType,
    sourceUri,
    fileSize,
    isFavorite,
    inLibrary,
    lastOpenedAt,
  })
}

function upsertDocument(items: DocumentRecord[], doc: DocumentRecord) {
  const existing = items.find((item) => item.id === doc.id)
  if (!existing) return [doc, ...items]

  return items.map((item) =>
    item.id === doc.id
      ? {
          ...existing,
          ...doc,
          isFavorite: existing.isFavorite || doc.isFavorite,
          inLibrary: existing.inLibrary || doc.inLibrary,
          lastReadPosition: doc.lastReadPosition || existing.lastReadPosition,
        }
      : item,
  )
}

function sortDocuments(items: DocumentRecord[]) {
  return [...items].sort(
    (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime(),
  )
}

function getExtension(fileName: string) {
  return fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? '' : ''
}

function isArchiveFileName(fileName: string) {
  return ['zip', 'rar'].includes(getExtension(fileName))
}

function inferFileType(fileName: string): DocumentType {
  const extension = getExtension(fileName)
  if (['md', 'markdown', 'mdown'].includes(extension)) return 'markdown'
  if (['html', 'htm', 'xhtml'].includes(extension)) return 'html'
  return 'text'
}

function looksLikeHtml(content: string) {
  const sample = content.trim().slice(0, 4096)
  return /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(sample)
    || /<(?:article|section|main|div|p|h[1-6]|table|style)(?:\s[^>]*)?>/i.test(sample)
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

async function readNativeStoredFile(path: string, expectedSize?: number) {
  const chunks: Uint8Array[] = []
  let output = expectedSize && expectedSize > 0 ? new Uint8Array(expectedSize) : null
  let offset = 0
  let totalSize = expectedSize && expectedSize > 0 ? expectedSize : 0

  while (true) {
    const result = await FastViewerFiles.readFileChunk({ path, offset, length: 256 * 1024 })
    totalSize = result.size || totalSize
    if (totalSize > 100 * 1024 * 1024) {
      throw new Error('文件超过 100 MB 安全上限')
    }
    if (result.bytesRead > 0) {
      const bytes = base64ToBytes(result.base64Content)
      if (!output && totalSize > 0) {
        output = new Uint8Array(totalSize)
        let restoredOffset = 0
        chunks.forEach((chunk) => {
          output?.set(chunk, restoredOffset)
          restoredOffset += chunk.length
        })
        chunks.length = 0
      }
      if (output && offset + bytes.length <= output.length) output.set(bytes, offset)
      else chunks.push(bytes)
      offset += bytes.length
    }
    if (result.done || result.bytesRead === 0) break
  }

  if (output && chunks.length === 0) return output.subarray(0, offset)

  const merged = new Uint8Array(offset)
  let cursor = 0
  if (output) {
    merged.set(output.subarray(0, Math.min(output.length, offset)))
    cursor = Math.min(output.length, offset)
  }
  for (const chunk of chunks) {
    merged.set(chunk, cursor)
    cursor += chunk.length
  }
  return merged
}

function resetViewportScroll() {
  window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

function stableDocumentId(fileName: string, content: string) {
  let hash = 0
  const input = `${fileName}:${content.slice(0, 2048)}:${content.length}`
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }
  return `${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}-${Math.abs(hash)}`
}

function findActiveHeading(
  fileType: DocumentType,
  headings: HeadingItem[],
  iframe: HTMLIFrameElement | null,
) {
  let active = ''
  const frameTop = fileType === 'html' ? iframe?.getBoundingClientRect().top ?? 0 : 0
  for (const heading of headings) {
    let element: HTMLElement | null | undefined
    try {
      element = fileType === 'html'
        ? iframe?.contentDocument?.getElementById(heading.id)
        : window.document.getElementById(heading.id)
    } catch {
      return active
    }
    if (!element) continue
    const top = element.getBoundingClientRect().top + frameTop
    if (top <= 132) active = heading.id
    else if (!active) return heading.id
    else break
  }
  return active
}

const MAX_EXPORT_CANVAS_EDGE = 32767
const MAX_EXPORT_CANVAS_PIXELS = 12_000_000
const EXPORT_RESOURCE_WAIT_TIMEOUT_MS = 3000

function calculateExportScale(width: number, height: number) {
  const edgeScale = MAX_EXPORT_CANVAS_EDGE / Math.max(1, width, height)
  const pixelScale = Math.sqrt(MAX_EXPORT_CANVAS_PIXELS / Math.max(1, width * height))
  return Math.max(0.01, Math.min(2, edgeScale, pixelScale))
}

function canvasToPngBytes(canvas: HTMLCanvasElement) {
  return new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法生成 PNG 图片'))
        return
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
}

function cropCanvas(source: HTMLCanvasElement, top: number, height: number) {
  const output = document.createElement('canvas')
  output.width = source.width
  output.height = Math.max(1, Math.min(height, source.height - top))
  output.getContext('2d')?.drawImage(
    source,
    0,
    top,
    source.width,
    output.height,
    0,
    0,
    output.width,
    output.height,
  )
  return output
}

function paginateCanvas(source: HTMLCanvasElement) {
  const pageHeight = Math.max(1, Math.round(source.width * 1.414))
  const pages: HTMLCanvasElement[] = []
  for (let top = 0; top < source.height; top += pageHeight) {
    pages.push(cropCanvas(source, top, Math.min(pageHeight, source.height - top)))
  }
  return pages
}

async function captureHtmlFrameAsCanvas(iframe: HTMLIFrameElement | null, themeMode: ThemeMode) {
  const frameDocument = iframe?.contentDocument
  const frameWindow = iframe?.contentWindow
  const targetElement = frameDocument?.body
  if (!iframe || !frameDocument || !frameWindow || !targetElement) {
    throw new Error('无法获取 HTML 绘制区域')
  }

  await waitForFrameResources(frameDocument)

  const originalHeight = iframe.style.height
  const originalOverflow = iframe.style.overflow

  try {
    let { width, height } = measureFrameDocument(frameDocument, iframe)
    iframe.style.height = `${height}px`
    iframe.style.overflow = 'hidden'

    await nextAnimationFrame(frameWindow)
    await nextAnimationFrame(frameWindow)

    ;({ width, height } = measureFrameDocument(frameDocument, iframe))
    const backgroundColor = resolveFrameBackground(frameDocument, themeMode)
    const scale = calculateExportScale(width, height)

    const { default: html2canvas } = await import('html2canvas-pro')
    return html2canvas(targetElement, {
      useCORS: true,
      scale,
      backgroundColor,
      windowWidth: width,
      windowHeight: height,
      width,
      height,
      scrollX: 0,
      scrollY: 0,
    })
  } finally {
    iframe.style.height = originalHeight
    iframe.style.overflow = originalOverflow
  }
}

async function captureHtmlSourceAsCanvas(srcDoc: string, themeMode: ThemeMode) {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;'
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.srcdoc = srcDoc
  document.body.appendChild(iframe)
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('HTML 导出准备超时')), 5000)
      iframe.addEventListener('load', () => {
        window.clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
    return await captureHtmlFrameAsCanvas(iframe, themeMode)
  } finally {
    iframe.remove()
  }
}

async function waitForFrameResources(frameDocument: Document) {
  await frameDocument.fonts?.ready.catch(() => undefined)

  const images = Array.from(frameDocument.images).filter((image) => !image.complete)
  await Promise.race([
    Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true })
            image.addEventListener('error', () => resolve(), { once: true })
          }),
      ),
    ),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, EXPORT_RESOURCE_WAIT_TIMEOUT_MS)
    }),
  ])
}

function measureFrameDocument(frameDocument: Document, iframe: HTMLIFrameElement) {
  const body = frameDocument.body
  const root = frameDocument.documentElement
  const width = Math.ceil(Math.max(
    iframe.clientWidth,
    root.clientWidth,
    root.scrollWidth,
    body.clientWidth,
    body.scrollWidth,
    body.offsetWidth,
  ))
  const height = Math.ceil(Math.max(
    iframe.clientHeight,
    root.clientHeight,
    root.scrollHeight,
    body.clientHeight,
    body.scrollHeight,
    body.offsetHeight,
  ))

  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  }
}

function resolveFrameBackground(frameDocument: Document, themeMode: ThemeMode) {
  const fallback = themeMode === 'dark' ? '#171e1a' : '#fffdf8'
  const frameWindow = frameDocument.defaultView
  if (!frameWindow) return fallback

  const bodyColor = frameWindow.getComputedStyle(frameDocument.body).backgroundColor
  if (bodyColor && bodyColor !== 'rgba(0, 0, 0, 0)' && bodyColor !== 'transparent') return bodyColor

  const rootColor = frameWindow.getComputedStyle(frameDocument.documentElement).backgroundColor
  if (rootColor && rootColor !== 'rgba(0, 0, 0, 0)' && rootColor !== 'transparent') return rootColor

  return fallback
}

function nextAnimationFrame(frameWindow: Window) {
  return new Promise<void>((resolve) => {
    frameWindow.requestAnimationFrame(() => resolve())
  })
}

const PRINT_CSS = `<style>@media print{body{margin:0;padding:12mm}table{page-break-inside:avoid}pre{white-space:pre-wrap;word-break:break-all}img{max-width:100%;page-break-inside:avoid}h1,h2,h3,h4,h5,h6{page-break-after:avoid}.reader-header,.reader-toolbar,.search-panel,.reader-status,.sheet-backdrop{display:none!important}}</style>`

function buildPrintDocument(title: string, bodyHtml: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color: #33413a; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.72; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px 20px 40px; }
    h1,h2,h3,h4,h5,h6 { color: #111a16; line-height: 1.28; margin: 1.4em 0 .65em; }
    h1 { font-size: 1.7em; margin-top: 0; }
    h2 { font-size: 1.42em; }
    h3 { font-size: 1.16em; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 16px; }
    img, video { max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #dde5dd; }
    th, td { padding: 8px 10px; border: 1px solid #dde5dd; }
    th { background: #f3f6f2; color: #111a16; }
    pre { padding: 13px; border-radius: 4px; overflow-x: auto; background: #f5f5f5; color: #333; }
    code { font-family: SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
    a { color: #138263; text-decoration: none; }
    blockquote { padding: 10px 12px; border-left: 3px solid #138263; background: #e3f3ed; margin-left: 0; }
    mark.search-hit { background: transparent; color: inherit; }
  </style>
  ${PRINT_CSS}
</head>
<body>${bodyHtml}</body>
</html>`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function highlightMatches(container: HTMLElement, query: string) {
  clearHighlights(container)
  const needle = query.trim()
  if (!needle) return []

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      return parent?.closest('style, script, [data-search-exclude="true"], .katex')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node instanceof Text && node.nodeValue?.toLowerCase().includes(needle.toLowerCase())) {
      textNodes.push(node)
    }
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? ''
    const lowerText = text.toLowerCase()
    const lowerNeedle = needle.toLowerCase()
    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let index = lowerText.indexOf(lowerNeedle)

    while (index >= 0) {
      fragment.append(document.createTextNode(text.slice(lastIndex, index)))
      const mark = document.createElement('mark')
      mark.className = 'search-hit'
      mark.textContent = text.slice(index, index + needle.length)
      fragment.append(mark)
      lastIndex = index + needle.length
      index = lowerText.indexOf(lowerNeedle, lastIndex)
    }

    fragment.append(document.createTextNode(text.slice(lastIndex)))
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return Array.from(container.querySelectorAll<HTMLElement>('mark.search-hit'))
}

function clearHighlights(container: HTMLElement) {
  container.querySelectorAll('mark.search-hit').forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''))
  })
  container.normalize()
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function inferDocumentMime(document: DocumentRecord) {
  if (document.fileType === 'html') return 'text/html'
  if (document.fileType === 'markdown') return 'text/markdown'
  return 'text/plain'
}

function formatTime(value: string) {
  const date = new Date(value)
  const diff = Date.now() - date.getTime()
  if (Number.isNaN(diff)) return '未知时间'
  if (diff < 1000 * 60 * 60) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`
  if (diff < 1000 * 60 * 60 * 24) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 1000 * 60 * 60 * 24 * 7) return `${Math.floor(diff / 86400000)} 天前`
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export default App
