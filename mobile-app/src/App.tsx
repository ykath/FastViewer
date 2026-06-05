import * as ReactShim from 'react'
import type React from 'react'
import {
  AlertCircle,
  Archive,
  BookOpen,
  ChevronLeft,
  Copy,
  FileCode2,
  FileText,
  FolderOpen,
  Home,
  ImageDown,
  ListTree,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Upload,
} from 'lucide-react'
import './App.css'

type View = 'home' | 'reader' | 'settings' | 'error'

type FileKind = 'Markdown' | 'HTML'

type FileItem = {
  id: string
  name: string
  kind: FileKind
  size: string
  time: string
  source: string
  favorite?: boolean
}

const recentFiles: FileItem[] = [
  {
    id: 'meeting-notes',
    name: '会议纪要.md',
    kind: 'Markdown',
    size: '24 KB',
    time: '今天 09:12',
    source: '微信',
    favorite: true,
  },
  {
    id: 'product-html',
    name: '产品需求说明.html',
    kind: 'HTML',
    size: '186 KB',
    time: '昨天 18:40',
    source: '文件管理器',
  },
  {
    id: 'ai-summary',
    name: 'AI 报告摘要.markdown',
    kind: 'Markdown',
    size: '62 KB',
    time: '周三',
    source: '邮箱',
  },
  {
    id: 'api-docs',
    name: '接口文档.htm',
    kind: 'HTML',
    size: '410 KB',
    time: '上周',
    source: '网盘',
  },
]

const libraryFiles = recentFiles.slice(0, 3)
const favoriteFiles = recentFiles.filter((file) => file.favorite)

function App() {
  const [view, setView] = useAppView()
  const [activeFile, setActiveFile] = useActiveFile()
  const [activeTab, setActiveTab] = useHomeTab()

  const openFile = (file: FileItem) => {
    setActiveFile(file)
    setView('reader')
  }

  const goHome = () => setView('home')

  return (
    <div className="app-shell">
      <main className="app-main">
        {view === 'home' && (
          <HomePage
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onOpenFile={openFile}
            onOpenError={() => setView('error')}
          />
        )}
        {view === 'reader' && (
          <ReaderPage file={activeFile} onBack={goHome} />
        )}
        {view === 'settings' && <SettingsPage />}
        {view === 'error' && <OpenErrorState onBack={goHome} />}
      </main>

      <BottomNav currentView={view} onNavigate={setView} />
    </div>
  )
}

function useAppView(): [View, (view: View) => void] {
  const state = ReactShim.useState<View>('home')
  return state
}

function useActiveFile(): [FileItem, (file: FileItem) => void] {
  const state = ReactShim.useState<FileItem>(recentFiles[0])
  return state
}

function useHomeTab(): [HomeTab, (tab: HomeTab) => void] {
  const state = ReactShim.useState<HomeTab>('recent')
  return state
}

type HomeTab = 'recent' | 'favorite' | 'library'

type HomePageProps = {
  activeTab: HomeTab
  onTabChange: (tab: HomeTab) => void
  onOpenFile: (file: FileItem) => void
  onOpenError: () => void
}

function HomePage({
  activeTab,
  onTabChange,
  onOpenFile,
  onOpenError,
}: HomePageProps) {
  const files =
    activeTab === 'recent'
      ? recentFiles
      : activeTab === 'favorite'
        ? favoriteFiles
        : libraryFiles

  return (
    <section className="page page-home" aria-label="轻页首页">
      <header className="home-header">
        <div>
          <p className="eyebrow">LightPage</p>
          <h1>轻页</h1>
          <p className="home-subtitle">Markdown / HTML 阅读器</p>
        </div>
        <button className="icon-button" type="button" aria-label="设置">
          <Settings size={20} />
        </button>
      </header>

      <section className="quick-actions" aria-label="打开方式">
        <button className="primary-action" type="button" onClick={() => onOpenFile(recentFiles[0])}>
          <FolderOpen size={20} />
          <span>打开文件</span>
        </button>
        <button className="secondary-action" type="button" onClick={onOpenError}>
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
          <EmptyState />
        ) : (
          files.map((file) => (
            <button
              className="file-row"
              type="button"
              key={file.id}
              onClick={() => onOpenFile(file)}
            >
              <span className={`file-icon ${file.kind.toLowerCase()}`}>
                {file.kind === 'Markdown' ? (
                  <FileText size={20} />
                ) : (
                  <FileCode2 size={20} />
                )}
              </span>
              <span className="file-main">
                <span className="file-name">{file.name}</span>
                <span className="file-meta">
                  {file.source} · {file.size} · {file.time}
                </span>
              </span>
              <span className="file-kind">{file.kind}</span>
            </button>
          ))
        )}
      </section>
    </section>
  )
}

type ReaderPageProps = {
  file: FileItem
  onBack: () => void
}

function ReaderPage({ file, onBack }: ReaderPageProps) {
  return (
    <section className="page page-reader" aria-label="文件阅读页">
      <header className="reader-header">
        <button className="icon-button" type="button" onClick={onBack} aria-label="返回">
          <ChevronLeft size={22} />
        </button>
        <div className="reader-title">
          <h1>{file.name}</h1>
          <p>来自{file.source} · {file.kind}</p>
        </div>
        <div className="reader-actions" aria-label="阅读操作">
          <button className="icon-button" type="button" aria-label="搜索">
            <Search size={19} />
          </button>
          <button className="icon-button" type="button" aria-label="目录">
            <ListTree size={19} />
          </button>
          <button className="icon-button" type="button" aria-label="更多">
            <Menu size={19} />
          </button>
        </div>
      </header>

      <div className="reader-status">
        <span>已恢复到 42%</span>
        <span>UTF-8</span>
        <span>本地处理</span>
      </div>

      <article className="reader-content">
        <p className="document-kicker">产品草案</p>
        <h2>手机端 Markdown / HTML 阅读器</h2>
        <p>
          轻页用于快速打开微信、文件管理器和邮箱中的 Markdown 与 HTML 文件，
          让移动端临时阅读、搜索和转发更顺手。
        </p>

        <h3>核心能力</h3>
        <ul>
          <li>直接打开 `.md`、`.markdown`、`.html`、`.htm` 文件。</li>
          <li>自动生成目录，并支持文内搜索和阅读位置恢复。</li>
          <li>默认本地处理，HTML 文件在安全沙盒中打开。</li>
        </ul>

        <blockquote>
          外出时只需要看懂文件，不需要先折腾文件管理器或代码编辑器。
        </blockquote>

        <div className="table-preview" role="img" aria-label="表格预览">
          <div>格式</div>
          <div>状态</div>
          <div>Markdown</div>
          <div>已支持</div>
          <div>HTML</div>
          <div>规划中</div>
        </div>

        <pre>
          <code>{'const mode = file.kind === "Markdown" ? "reader" : "sandbox";'}</code>
        </pre>
      </article>

      <footer className="reader-toolbar" aria-label="阅读工具">
        <button type="button">
          <Sun size={18} />
          <span>主题</span>
        </button>
        <button type="button">
          <SlidersHorizontal size={18} />
          <span>字号</span>
        </button>
        <button type="button">
          <Upload size={18} />
          <span>PDF</span>
        </button>
        <button type="button">
          <ImageDown size={18} />
          <span>图片</span>
        </button>
      </footer>
    </section>
  )
}

function SettingsPage() {
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
          icon={<Sun size={19} />}
          title="浅色模式"
          description="适合白天和普通阅读环境"
          value="启用"
        />
        <SettingRow
          icon={<Moon size={19} />}
          title="跟随系统深浅色"
          description="后续将接入系统主题"
          value="预留"
        />
        <SettingRow
          icon={<ShieldCheck size={19} />}
          title="HTML 安全沙盒"
          description="默认禁用脚本、自动跳转和自动下载"
          value="默认"
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
}

function SettingRow({ icon, title, description, value }: SettingRowProps) {
  return (
    <div className="setting-row">
      <span className="setting-icon">{icon}</span>
      <span className="setting-copy">
        <span className="setting-title">{title}</span>
        <span className="setting-description">{description}</span>
      </span>
      <span className="setting-value">{value}</span>
    </div>
  )
}

function OpenErrorState({ onBack }: { onBack: () => void }) {
  return (
    <section className="page page-error" aria-label="打开失败">
      <div className="error-panel">
        <span className="error-icon">
          <AlertCircle size={28} />
        </span>
        <h1>暂时无法打开</h1>
        <p>
          当前入口还没有接入真实剪贴板或外部文件读取。M1 阶段先保留错误状态，
          后续 M3 会接入 Android 外部文件打开。
        </p>
        <div className="error-actions">
          <button className="primary-action compact" type="button" onClick={onBack}>
            返回首页
          </button>
          <button className="secondary-action compact" type="button">
            查看源码
          </button>
        </div>
      </div>
    </section>
  )
}

function EmptyState() {
  return (
    <div className="empty-state">
      <BookOpen size={24} />
      <p>这里还没有文件</p>
      <span>从微信或文件管理器打开后会出现在这里。</span>
    </div>
  )
}

type BottomNavProps = {
  currentView: View
  onNavigate: (view: View) => void
}

function BottomNav({ currentView, onNavigate }: BottomNavProps) {
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

export default App
