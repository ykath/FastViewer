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
  Menu,
  Moon,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Sun,
  Upload,
  X,
} from 'lucide-react'
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import './App.css'

type View = 'home' | 'reader' | 'settings' | 'error'
type HomeTab = 'recent' | 'favorite' | 'library'
type DocumentType = 'markdown' | 'html' | 'text'
type ThemeMode = 'light' | 'dark'
type ReaderMode = 'rendered' | 'source'

type DocumentRecord = {
  id: string
  fileName: string
  fileExtension: string
  fileType: DocumentType
  fileSize: number
  sourceType: string
  sourceUri?: string
  content: string
  encoding: string
  lastOpenedAt: string
  createdAt: string
  isFavorite: boolean
  inLibrary: boolean
  lastReadPosition: number
  trustedHtml?: boolean
}

type HeadingItem = {
  id: string
  level: number
  text: string
}

type ToastState = {
  message: string
  tone?: 'normal' | 'success' | 'warning'
}

type ExternalFileResult = {
  hasFile?: boolean
  uri?: string
  fileName?: string
  mimeType?: string
  content?: string
  size?: number
  error?: string
}

type ExternalResource = {
  tag: string
  attr: string
  url: string
}

type HtmlRenderInfo = {
  srcDoc: string
  headings: HeadingItem[]
  plainText: string
  externalResources: ExternalResource[]
}

type FastViewerFilesPlugin = {
  getLaunchFile: () => Promise<ExternalFileResult>
  addListener: (
    eventName: 'fileOpen',
    listenerFunc: (result: ExternalFileResult) => void,
  ) => Promise<PluginListenerHandle>
}

const FastViewerFiles = registerPlugin<FastViewerFilesPlugin>('FastViewerFiles')

const STORAGE_KEY = 'lightpage.documents.v1'
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
  const [documents, setDocuments] = usePersistentDocuments()
  const [activeDocumentId, setActiveDocumentId] = useState(documents[0]?.id ?? '')
  const [errorMessage, setErrorMessage] = useState('')
  const [toast, setToast] = useState<ToastState | null>(null)
  const [settings, setSettings] = usePersistentSettings()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const activeDocument = documents.find((doc) => doc.id === activeDocumentId) ?? documents[0]

  useEffect(() => {
    document.documentElement.dataset.theme = settings.themeMode
  }, [settings.themeMode])

  useEffect(() => {
    if (!activeDocumentId && documents[0]) {
      setActiveDocumentId(documents[0].id)
    }
  }, [activeDocumentId, documents])

  const showToast = (message: string, tone: ToastState['tone'] = 'normal') => {
    setToast({ message, tone })
    window.setTimeout(() => setToast(null), 2200)
  }

  const persistDocuments = (updater: (items: DocumentRecord[]) => DocumentRecord[]) => {
    setDocuments((current) => {
      const next = updater(current)
      return sortDocuments(next)
    })
  }

  const openDocument = (doc: DocumentRecord) => {
    const openedAt = new Date().toISOString()
    persistDocuments((items) =>
      upsertDocument(items, { ...doc, lastOpenedAt: openedAt }),
    )
    setActiveDocumentId(doc.id)
    setView('reader')
  }

  const importDocument = (doc: DocumentRecord, openAfterImport = true) => {
    persistDocuments((items) => upsertDocument(items, doc))
    setActiveDocumentId(doc.id)
    if (openAfterImport) {
      setView('reader')
    }
  }

  const importExternalResult = (result: ExternalFileResult) => {
    if (result.error) {
      setErrorMessage(result.error)
      setView('error')
      return
    }

    if (!result.hasFile || !result.content || !result.fileName) return

    const record = createRecordFromContent({
      fileName: result.fileName,
      content: result.content,
      sourceType: '外部应用',
      sourceUri: result.uri,
      fileSize: result.size,
    })

    importDocument(record)
    showToast(record.fileType === 'html' ? '已安全打开 HTML 文件' : '已从外部应用打开文件', 'success')
  }

  const loadExternalLaunchFile = async () => {
    if (!Capacitor.isNativePlatform()) return

    try {
      const result = await FastViewerFiles.getLaunchFile()
      importExternalResult(result)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '外部文件读取失败')
      setView('error')
    }
  }

  useEffect(() => {
    void loadExternalLaunchFile()
    // Only run once on app boot to consume the native launch intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined

    let handle: PluginListenerHandle | undefined
    void FastViewerFiles.addListener('fileOpen', (result) => {
      importExternalResult(result)
    }).then((listenerHandle) => {
      handle = listenerHandle
    })

    return () => {
      void handle?.remove()
    }
    // Listener should stay attached for the app lifetime; callbacks use current state through React rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePickedFile = async (file: File) => {
    try {
      const content = await file.text()
      const record = createRecordFromContent({
        fileName: file.name,
        content,
        sourceType: '文件选择器',
        fileSize: file.size,
      })

      importDocument(record)
      showToast('文件已打开', 'success')
    } catch {
      setErrorMessage('文件读取失败，请确认文件仍可访问。')
      setView('error')
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const updateActiveDocument = (patch: Partial<DocumentRecord>) => {
    if (!activeDocument) return
    persistDocuments((items) =>
      items.map((item) =>
        item.id === activeDocument.id ? { ...item, ...patch } : item,
      ),
    )
  }

  const deleteDocument = (doc: DocumentRecord) => {
    persistDocuments((items) => items.filter((item) => item.id !== doc.id))
    if (activeDocumentId === doc.id) {
      const next = documents.find((item) => item.id !== doc.id)
      setActiveDocumentId(next?.id ?? '')
    }
    showToast('已删除本地记录', 'success')
  }

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".md,.markdown,.mdown,.html,.htm,text/markdown,text/html,text/plain"
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
            onPickFile={() => fileInputRef.current?.click()}
            onDelete={deleteDocument}
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
            onBack={() => setView('home')}
            onUpdate={updateActiveDocument}
            onShowToast={showToast}
            onSetSettings={setSettings}
          />
        )}

        {view === 'settings' && (
          <SettingsPage settings={settings} onSetSettings={setSettings} />
        )}

        {view === 'error' && (
          <OpenErrorState
            message={errorMessage}
            onBack={() => setView('home')}
            onPickFile={() => fileInputRef.current?.click()}
          />
        )}
      </main>

      <BottomNav
        currentView={view}
        hasReader={Boolean(activeDocument)}
        onNavigate={(nextView) => {
          if (nextView === 'reader' && !activeDocument) return
          setView(nextView)
        }}
      />

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
  onDelete: (doc: DocumentRecord) => void
  onToggleFavorite: (doc: DocumentRecord) => void
}

function HomePage({
  activeTab,
  documents,
  onTabChange,
  onOpenFile,
  onPickFile,
  onDelete,
  onToggleFavorite,
}: HomePageProps) {
  const files = useMemo(() => {
    if (activeTab === 'favorite') return documents.filter((doc) => doc.isFavorite)
    if (activeTab === 'library') return documents.filter((doc) => doc.inLibrary)
    return documents
  }, [activeTab, documents])

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
        <button className="secondary-action" type="button" onClick={onPickFile}>
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

      <section className="file-list" aria-label="文件列表">
        {files.length === 0 ? (
          <EmptyState tab={activeTab} />
        ) : (
          files.map((file) => (
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
      </section>
    </section>
  )
}

type ReaderPageProps = {
  document: DocumentRecord
  settings: ReaderSettings
  onBack: () => void
  onUpdate: (patch: Partial<DocumentRecord>) => void
  onShowToast: (message: string, tone?: ToastState['tone']) => void
  onSetSettings: (settings: ReaderSettings) => void
}

function ReaderPage({
  document,
  settings,
  onBack,
  onUpdate,
  onShowToast,
  onSetSettings,
}: ReaderPageProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchCount, setSearchCount] = useState(0)
  const [tocOpen, setTocOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [readerMode, setReaderMode] = useState<ReaderMode>('rendered')
  const [allowExternalOnce, setAllowExternalOnce] = useState(false)
  const [htmlFrameVersion, setHtmlFrameVersion] = useState(0)
  const contentRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const allowExternalResources = document.fileType === 'html' && (allowExternalOnce || Boolean(document.trustedHtml))
  const htmlInfo = useMemo(
    () =>
      document.fileType === 'html'
        ? buildSafeHtmlDocument(document.content, { allowExternalResources })
        : null,
    [allowExternalResources, document.content, document.fileType],
  )
  const headings = useMemo(
    () => (document.fileType === 'html' ? htmlInfo?.headings ?? [] : extractMarkdownHeadings(document.content)),
    [document.content, document.fileType, htmlInfo],
  )
  const markdownComponents = createMarkdownComponents()

  useEffect(() => {
    setQuery('')
    setSearchOpen(false)
    setSearchIndex(0)
    setReaderMode('rendered')
    setAllowExternalOnce(false)
    window.setTimeout(() => {
      scrollRef.current?.scrollTo({ top: document.lastReadPosition })
    }, 0)
  }, [document.id, document.lastReadPosition])

  const getSearchContainer = useCallback(() => {
    if (document.fileType === 'html') {
      return iframeRef.current?.contentDocument?.body ?? null
    }

    return contentRef.current
  }, [document.fileType])

  useEffect(() => {
    const container = getSearchContainer()
    if (!container || readerMode !== 'rendered') {
      setSearchCount(0)
      return
    }
    const count = highlightMatches(container, query)
    setSearchCount(count)
    const target = container.querySelectorAll('mark.search-hit')[searchIndex]
    target?.scrollIntoView({ block: 'center' })
  }, [getSearchContainer, query, searchIndex, readerMode, document.content, htmlFrameVersion, htmlInfo?.srcDoc])

  const saveScrollPosition = () => {
    const top = scrollRef.current?.scrollTop ?? 0
    if (Math.abs(top - document.lastReadPosition) > 80) {
      onUpdate({ lastReadPosition: top })
    }
  }

  const changeFontSize = (delta: number) => {
    const next = clamp(settings.fontSizeLevel + delta, 0, 4)
    onSetSettings({ ...settings, fontSizeLevel: next })
  }

  const toggleTheme = () => {
    onSetSettings({
      ...settings,
      themeMode: settings.themeMode === 'light' ? 'dark' : 'light',
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

  const copyText = async (source = document.fileType === 'html' ? htmlInfo?.plainText ?? document.content : document.content) => {
    try {
      await navigator.clipboard.writeText(source)
      onShowToast('已复制全文', 'success')
    } catch {
      onShowToast('复制失败，请检查系统权限', 'warning')
    }
  }

  const nextSearchResult = (delta: number) => {
    if (searchCount === 0) return
    setSearchIndex((current) => (current + delta + searchCount) % searchCount)
  }

  const statusText =
    document.lastReadPosition > 0 ? '已恢复阅读位置' : '从顶部开始'

  const handleHtmlFrameLoad = () => {
    const frameDocument = iframeRef.current?.contentDocument
    if (!frameDocument) return

    frameDocument.querySelectorAll('a[href]').forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        const href = (event.currentTarget as HTMLAnchorElement).href
        if (!href) return

        event.preventDefault()
        if (window.confirm(`要打开外部链接吗？\n${href}`)) {
          window.open(href, '_blank', 'noopener,noreferrer')
        }
      })
    })

    setHtmlFrameVersion((version) => version + 1)
  }

  return (
    <section
      className={`page page-reader font-level-${settings.fontSizeLevel}`}
      aria-label="文件阅读页"
      ref={scrollRef}
      onScroll={saveScrollPosition}
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
          <button className="icon-button" type="button" onClick={() => setSearchOpen(true)} aria-label="搜索">
            <Search size={19} />
          </button>
          <button className="icon-button" type="button" onClick={() => setTocOpen(true)} aria-label="目录">
            <ListTree size={19} />
          </button>
          <button className="icon-button" type="button" onClick={() => setMenuOpen(true)} aria-label="更多">
            <Menu size={19} />
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="search-panel">
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
          <button type="button" onClick={() => nextSearchResult(-1)}>上</button>
          <button type="button" onClick={() => nextSearchResult(1)}>下</button>
          <button type="button" onClick={() => setSearchOpen(false)} aria-label="关闭搜索">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="reader-status">
        <span>{statusText}</span>
        <span>{document.encoding}</span>
        <span>本地处理</span>
      </div>

      {readerMode === 'source' ? (
        <pre className="source-view">{document.content}</pre>
      ) : document.fileType === 'html' && htmlInfo ? (
        <HtmlReader
          iframeRef={iframeRef}
          info={htmlInfo}
          trusted={Boolean(document.trustedHtml)}
          allowExternalOnce={allowExternalOnce}
          onFrameLoad={handleHtmlFrameLoad}
          onAllowExternalOnce={() => setAllowExternalOnce(true)}
          onBlockExternal={() => setAllowExternalOnce(false)}
          onTrustFile={() => {
            onUpdate({ trustedHtml: true })
            onShowToast('已信任此 HTML 文件', 'success')
          }}
          onRevokeTrust={() => {
            onUpdate({ trustedHtml: false })
            setAllowExternalOnce(false)
            onShowToast('已恢复阻止外部资源', 'success')
          }}
        />
      ) : document.fileType === 'markdown' ? (
        <article className="reader-content markdown-body" ref={contentRef}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {document.content}
          </ReactMarkdown>
        </article>
      ) : (
        <TextReader content={document.content} />
      )}

      <footer className="reader-toolbar" aria-label="阅读工具">
        <button type="button" onClick={toggleTheme}>
          {settings.themeMode === 'light' ? <Sun size={18} /> : <Moon size={18} />}
          <span>主题</span>
        </button>
        <button type="button" onClick={() => changeFontSize(-1)}>
          <SlidersHorizontal size={18} />
          <span>A-</span>
        </button>
        <button type="button" onClick={() => changeFontSize(1)}>
          <SlidersHorizontal size={18} />
          <span>A+</span>
        </button>
        <button type="button" onClick={() => copyText()}>
          <Copy size={18} />
          <span>复制</span>
        </button>
      </footer>

      {tocOpen && (
        <Sheet title="目录" onClose={() => setTocOpen(false)}>
          {headings.length === 0 ? (
            <p className="sheet-empty">当前文档没有标题。</p>
          ) : (
            <div className="toc-list">
              {headings.map((heading) => (
                <button
                  key={heading.id}
                  className={`toc-item level-${heading.level}`}
                  type="button"
                  onClick={() => {
                    if (document.fileType === 'html') {
                      iframeRef.current?.contentDocument?.getElementById(heading.id)?.scrollIntoView({ block: 'start' })
                    } else {
                      window.document.getElementById(heading.id)?.scrollIntoView({ block: 'start' })
                    }
                    setTocOpen(false)
                  }}
                >
                  {heading.text}
                </button>
              ))}
            </div>
          )}
        </Sheet>
      )}

      {menuOpen && (
        <Sheet title="文件操作" onClose={() => setMenuOpen(false)}>
          <div className="menu-list">
            <MenuAction icon={<Archive size={18} />} label="保存到文件库" onClick={saveToLibrary} />
            <MenuAction
              icon={<Heart size={18} />}
              label={document.isFavorite ? '取消收藏' : '收藏'}
              onClick={toggleFavorite}
            />
            <MenuAction
              icon={<FileCode2 size={18} />}
              label={readerMode === 'source' ? '查看阅读视图' : '查看源码'}
              onClick={() => setReaderMode(readerMode === 'source' ? 'rendered' : 'source')}
            />
            <MenuAction icon={<Copy size={18} />} label="复制全文" onClick={() => copyText()} />
            {document.fileType === 'html' && (
              <MenuAction
                icon={<ShieldCheck size={18} />}
                label={document.trustedHtml ? '取消信任此 HTML' : '信任此 HTML'}
                onClick={() => {
                  if (document.trustedHtml) {
                    onUpdate({ trustedHtml: false })
                    setAllowExternalOnce(false)
                    onShowToast('已取消信任', 'success')
                  } else {
                    onUpdate({ trustedHtml: true })
                    onShowToast('已信任此 HTML 文件', 'success')
                  }
                }}
              />
            )}
            <MenuAction icon={<Upload size={18} />} label="导出 PDF（占位）" onClick={() => onShowToast('PDF 导出将在 M11 实现')} />
            <MenuAction icon={<ImageDown size={18} />} label="分享图片（占位）" onClick={() => onShowToast('图片分享将在 M11 实现')} />
            <MenuAction icon={<Share2 size={18} />} label="分享原文件（占位）" onClick={() => onShowToast('原文件分享将在 M11 实现')} />
          </div>
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
  trusted,
  allowExternalOnce,
  onAllowExternalOnce,
  onBlockExternal,
  onTrustFile,
  onRevokeTrust,
  onFrameLoad,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  info: HtmlRenderInfo
  trusted: boolean
  allowExternalOnce: boolean
  onAllowExternalOnce: () => void
  onBlockExternal: () => void
  onTrustFile: () => void
  onRevokeTrust: () => void
  onFrameLoad: () => void
}) {
  const hasExternal = info.externalResources.length > 0

  return (
    <div className="html-reader">
      <section className="html-security-panel">
        <div className="html-security-title">
          <ShieldCheck size={18} />
          <strong>已在安全沙盒中打开</strong>
        </div>
        <div className="html-security-tags">
          <span>脚本已禁用</span>
          <span>阻止自动跳转</span>
          <span>{trusted || allowExternalOnce ? '外部资源已允许' : '外部资源默认阻止'}</span>
        </div>
        {hasExternal && (
          <div className="external-resource-prompt">
            <p>此文件请求加载 {info.externalResources.length} 个外部资源。</p>
            <div>
              <button className="secondary-action compact" type="button" onClick={onBlockExternal}>
                保持阻止
              </button>
              <button className="primary-action compact" type="button" onClick={onAllowExternalOnce}>
                允许一次
              </button>
              <button className="secondary-action compact" type="button" onClick={trusted ? onRevokeTrust : onTrustFile}>
                {trusted ? '取消信任' : '信任此文件'}
              </button>
            </div>
          </div>
        )}
      </section>

      <iframe
        ref={iframeRef}
        className="html-frame"
        title="HTML 阅读视图"
        sandbox="allow-same-origin"
        srcDoc={info.srcDoc}
        onLoad={onFrameLoad}
      />
    </div>
  )
}

type ReaderSettings = {
  themeMode: ThemeMode
  fontSizeLevel: number
}

type SettingsPageProps = {
  settings: ReaderSettings
  onSetSettings: (settings: ReaderSettings) => void
}

function SettingsPage({ settings, onSetSettings }: SettingsPageProps) {
  return (
    <section className="page page-settings" aria-label="设置">
      <header className="simple-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>设置</h1>
        </div>
      </header>

      <section className="settings-list">
        <SettingRow
          icon={settings.themeMode === 'light' ? <Sun size={19} /> : <Moon size={19} />}
          title="阅读主题"
          description="浅色和深色即时切换"
          value={settings.themeMode === 'light' ? '浅色' : '深色'}
          onClick={() =>
            onSetSettings({
              ...settings,
              themeMode: settings.themeMode === 'light' ? 'dark' : 'light',
            })
          }
        />
        <SettingRow
          icon={<SlidersHorizontal size={19} />}
          title="字号档位"
          description="阅读页可通过 A- / A+ 调整"
          value={`${settings.fontSizeLevel + 1}/5`}
        />
        <SettingRow
          icon={<ShieldCheck size={19} />}
          title="HTML 安全沙盒"
          description="默认禁用脚本、自动跳转和自动下载"
          value="启用"
        />
        <SettingRow
          icon={<Archive size={19} />}
          title="本地文件库"
          description="保存到 App 内的文件仅保存在本机"
          value="本地"
        />
      </section>
    </section>
  )
}

type SettingRowProps = {
  icon: React.ReactNode
  title: string
  description: string
  value: string
  onClick?: () => void
}

function SettingRow({ icon, title, description, value, onClick }: SettingRowProps) {
  const Component = onClick ? 'button' : 'div'
  return (
    <Component className="setting-row" type={onClick ? 'button' : undefined} onClick={onClick}>
      <span className="setting-icon">{icon}</span>
      <span className="setting-copy">
        <span className="setting-title">{title}</span>
        <span className="setting-description">{description}</span>
      </span>
      <span className="setting-value">{value}</span>
    </Component>
  )
}

function OpenErrorState({
  message,
  onBack,
  onPickFile,
}: {
  message: string
  onBack: () => void
  onPickFile: () => void
}) {
  return (
    <section className="page page-error" aria-label="打开失败">
      <div className="error-panel">
        <span className="error-icon">
          <AlertCircle size={28} />
        </span>
        <h1>暂时无法打开</h1>
        <p>{message || '文件读取失败，请确认文件格式和访问权限。'}</p>
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

function usePersistentDocuments() {
  return usePersistentState<DocumentRecord[]>(STORAGE_KEY, seedDocuments)
}

function usePersistentSettings() {
  return usePersistentState<ReaderSettings>(SETTINGS_KEY, {
    themeMode: 'light',
    fontSizeLevel: 2,
  })
}

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue] as const
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
    content: stripUtf8Bom(content),
    encoding: 'UTF-8',
    lastOpenedAt: lastOpenedAt ?? now,
    createdAt: now,
    isFavorite,
    inLibrary,
    lastReadPosition: 0,
  }
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

function inferFileType(fileName: string): DocumentType {
  const extension = getExtension(fileName)
  if (['md', 'markdown', 'mdown'].includes(extension)) return 'markdown'
  if (['html', 'htm', 'xhtml'].includes(extension)) return 'html'
  return 'text'
}

function stableDocumentId(fileName: string, content: string) {
  let hash = 0
  const input = `${fileName}:${content.slice(0, 2048)}:${content.length}`
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }
  return `${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}-${Math.abs(hash)}`
}

function stripUtf8Bom(content: string) {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

function extractMarkdownHeadings(markdown: string): HeadingItem[] {
  const used = new Map<string, number>()
  return markdown
    .split(/\r?\n/)
    .map((line) => /^(#{1,6})\s+(.+?)\s*#*$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => {
      const text = match[2].trim()
      const baseId = slugify(text)
      const count = used.get(baseId) ?? 0
      used.set(baseId, count + 1)
      return {
        id: count ? `${baseId}-${count}` : baseId,
        level: match[1].length,
        text,
      }
    })
}

function extractHtmlHeadings(root: Document): HeadingItem[] {
  const used = new Map<string, number>()
  return Array.from(root.body.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((element) => {
    const text = element.textContent?.trim() || '未命名标题'
    const baseId = slugify(text)
    const count = used.get(baseId) ?? 0
    used.set(baseId, count + 1)
    const id = count ? `${baseId}-${count}` : baseId
    element.id = element.id || id

    return {
      id: element.id,
      level: Number(element.tagName.slice(1)),
      text,
    }
  })
}

function buildSafeHtmlDocument(
  html: string,
  { allowExternalResources }: { allowExternalResources: boolean },
): HtmlRenderInfo {
  const parser = new DOMParser()
  const parsed = parser.parseFromString(html, 'text/html')
  const externalResources: ExternalResource[] = []

  const recordExternalResource = (element: Element, attr: string, url: string) => {
    if (!isExternalUrl(url)) {
      return
    }

    externalResources.push({
      tag: element.tagName.toLowerCase(),
      attr,
      url,
    })
  }

  parsed.querySelectorAll('script[src], iframe[src], object[data], embed[src]').forEach((element) => {
    const resourceAttrs = ['src', 'data']
    resourceAttrs.forEach((attr) => {
      const value = element.getAttribute(attr)
      if (value) {
        recordExternalResource(element, attr, value)
      }
    })
  })

  parsed.querySelectorAll('script,iframe,object,embed,form,meta[http-equiv]').forEach((node) => node.remove())

  parsed.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value

      if (name === 'style') {
        collectExternalCssUrls(value).forEach((url) => recordExternalResource(element, 'style', url))
        if (!allowExternalResources) {
          element.setAttribute(attribute.name, stripExternalCssUrls(value))
        }
      }

      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        return
      }

      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name)
        return
      }

      if ((name === 'href' || name === 'src') && isExternalUrl(value)) {
        recordExternalResource(element, name, value)

        if (!allowExternalResources) {
          element.removeAttribute(attribute.name)
          element.setAttribute(`data-blocked-${name}`, value)
          if (element.tagName.toLowerCase() === 'img') {
            const notice = parsed.createElement('span')
            notice.className = 'lp-missing-resource'
            notice.textContent = `外部图片已阻止：${value}`
            element.insertAdjacentElement('afterend', notice)
          }
        }
      }
    })
  })

  parsed.querySelectorAll('style').forEach((element) => {
    const css = element.textContent ?? ''
    collectExternalCssUrls(css).forEach((url) => recordExternalResource(element, 'style', url))
    if (!allowExternalResources) {
      element.textContent = stripExternalCssUrls(css)
    }
  })

  const headings = extractHtmlHeadings(parsed)
  const plainText = parsed.body.textContent?.replace(/\n{3,}/g, '\n\n').trim() ?? ''
  const bodyHtml = parsed.body.innerHTML
  const title = parsed.title || 'HTML 文档'

  return {
    srcDoc: `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base target="_blank" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color: #33413a;
      background: #fffdf8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 16px;
      line-height: 1.72;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px 20px 108px; overflow-wrap: anywhere; }
    h1,h2,h3,h4,h5,h6 { color: #111a16; line-height: 1.28; margin: 1.4em 0 .65em; }
    h1 { font-size: 1.7em; margin-top: 0; }
    h2 { font-size: 1.42em; }
    h3 { font-size: 1.16em; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 16px; }
    img, video { max-width: 100%; height: auto; border-radius: 8px; }
    table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; border: 1px solid #dde5dd; border-radius: 8px; }
    th, td { padding: 8px 10px; border: 1px solid #dde5dd; white-space: nowrap; }
    th { background: #f3f6f2; color: #111a16; }
    pre { padding: 13px; border-radius: 8px; overflow-x: auto; color: #d6eee4; background: #18211d; }
    code { font-family: SFMono-Regular, Consolas, monospace; }
    a { color: #138263; text-decoration: none; }
    blockquote { padding: 10px 12px; border-left: 3px solid #138263; border-radius: 0 8px 8px 0; background: #e3f3ed; }
    .lp-missing-resource { display: block; margin: 8px 0 14px; padding: 9px 10px; border-radius: 8px; color: #9a5b08; background: #fff1d8; font-size: .86em; }
    mark.search-hit { padding: 0 2px; border-radius: 3px; color: #1f1600; background: #ffd86b; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`,
    headings,
    plainText,
    externalResources,
  }
}

function isExternalUrl(value: string) {
  return /^(https?:)?\/\//i.test(value.trim())
}

function collectExternalCssUrls(css: string) {
  const matches = css.matchAll(/(?:url\(\s*['"]?|@import\s+['"])((?:https?:)?\/\/[^'")\s;]+)/gi)
  return Array.from(matches, (match) => match[1])
}

function stripExternalCssUrls(css: string) {
  return css
    .replace(/url\(\s*['"]?(?:https?:)?\/\/[^'")\s;]+['"]?\s*\)/gi, 'none')
    .replace(/@import\s+['"](?:https?:)?\/\/[^'"]+['"]\s*;?/gi, '')
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function slugify(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~()[\]{}:;'"，。！？、]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '') || 'heading'
  )
}

function createMarkdownComponents(): Components {
  const used = new Map<string, number>()

  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => {
    const tagName = `h${level}`
    return function Heading({
      children,
      ...props
    }: React.HTMLAttributes<HTMLHeadingElement>) {
      const text = childrenToText(children)
      const baseId = slugify(text)
      const count = used.get(baseId) ?? 0
      used.set(baseId, count + 1)
      const id = count ? `${baseId}-${count}` : baseId
      return createElement(tagName, { id, ...props }, children)
    }
  }

  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      )
    },
    a({ children, href }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    },
    img({ alt, src }) {
      return <img src={src} alt={alt ?? ''} loading="lazy" />
    },
  }
}

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  return ''
}

function highlightMatches(container: HTMLElement, query: string) {
  clearHighlights(container)
  const needle = query.trim()
  if (!needle) return 0

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node instanceof Text && node.nodeValue?.toLowerCase().includes(needle.toLowerCase())) {
      textNodes.push(node)
    }
  }

  let count = 0
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
      count += 1
      lastIndex = index + needle.length
      index = lowerText.indexOf(lowerNeedle, lastIndex)
    }

    fragment.append(document.createTextNode(text.slice(lastIndex)))
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  return count
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
