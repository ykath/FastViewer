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
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Capacitor, registerPlugin } from '@capacitor/core'
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

type FastViewerFilesPlugin = {
  getLaunchFile: () => Promise<ExternalFileResult>
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
      content: '<h1>产品需求说明</h1><p>HTML 浏览将在 M7 实现。</p>',
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

  useEffect(() => {
    void loadExternalLaunchFile()
    // Only run once on app boot to consume the native launch intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const loadExternalLaunchFile = async () => {
    if (!Capacitor.isNativePlatform()) return

    try {
      const result = await FastViewerFiles.getLaunchFile()
      if (!result.hasFile || !result.content || !result.fileName) return

      const record = createRecordFromContent({
        fileName: result.fileName,
        content: result.content,
        sourceType: '外部应用',
        sourceUri: result.uri,
        fileSize: result.size,
      })
      importDocument(record)
      showToast('已从外部应用打开文件', 'success')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '外部文件读取失败')
      setView('error')
    }
  }

  const handlePickedFile = async (file: File) => {
    try {
      const content = await file.text()
      const record = createRecordFromContent({
        fileName: file.name,
        content,
        sourceType: '文件选择器',
        fileSize: file.size,
      })

      if (record.fileType === 'html') {
        importDocument(record, false)
        setErrorMessage('HTML 浏览将在 M7 阶段实现。当前版本已保存文件记录，但只支持 Markdown 阅读。')
        setView('error')
        return
      }

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
  const contentRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)

  const headings = useMemo(() => extractHeadings(document.content), [document.content])
  const markdownComponents = createMarkdownComponents()

  useEffect(() => {
    setQuery('')
    setSearchOpen(false)
    setSearchIndex(0)
    setReaderMode('rendered')
    window.setTimeout(() => {
      scrollRef.current?.scrollTo({ top: document.lastReadPosition })
    }, 0)
  }, [document.id, document.lastReadPosition])

  useEffect(() => {
    const container = contentRef.current
    if (!container || readerMode !== 'rendered') {
      setSearchCount(0)
      return
    }
    const count = highlightMatches(container, query)
    setSearchCount(count)
    const target = container.querySelectorAll('mark.search-hit')[searchIndex]
    target?.scrollIntoView({ block: 'center' })
  }, [query, searchIndex, readerMode, document.content])

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

  const copyText = async (source = document.content) => {
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

      {document.fileType !== 'markdown' ? (
        <UnsupportedDocument document={document} onBack={onBack} />
      ) : readerMode === 'source' ? (
        <pre className="source-view">{document.content}</pre>
      ) : (
        <article className="reader-content markdown-body" ref={contentRef}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {document.content}
          </ReactMarkdown>
        </article>
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
                    window.document.getElementById(heading.id)?.scrollIntoView({ block: 'start' })
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
            <MenuAction icon={<Upload size={18} />} label="导出 PDF（占位）" onClick={() => onShowToast('PDF 导出将在 M11 实现')} />
            <MenuAction icon={<ImageDown size={18} />} label="分享图片（占位）" onClick={() => onShowToast('图片分享将在 M11 实现')} />
            <MenuAction icon={<Share2 size={18} />} label="分享原文件（占位）" onClick={() => onShowToast('原文件分享将在 M11 实现')} />
          </div>
        </Sheet>
      )}
    </section>
  )
}

function UnsupportedDocument({ document, onBack }: { document: DocumentRecord; onBack: () => void }) {
  return (
    <div className="unsupported-doc">
      <AlertCircle size={30} />
      <h2>当前版本暂不支持 {document.fileExtension.toUpperCase()} 阅读</h2>
      <p>M2-M6 阶段先完成 Markdown 发布测试。HTML 浏览会在 M7 阶段接入安全沙盒。</p>
      <button className="primary-action compact" type="button" onClick={onBack}>
        返回首页
      </button>
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
          description="M7 阶段默认禁用脚本和自动跳转"
          value="预留"
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

function extractHeadings(markdown: string): HeadingItem[] {
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
