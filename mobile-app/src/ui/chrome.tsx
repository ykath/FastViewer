import { type FileOpenError, type FileOpenErrorCode, type HomeTab, type View } from '../app/types'
import { directoryFileDetails, looksLikeHtml } from '../app/records'
import { AlertCircle, BookOpen, Command, FileText, FolderOpen, Home, Loader2, Settings, X } from 'lucide-react'
import React, { useMemo } from 'react'
import type { HtmlRenderInfo } from '../html-processing'
import type { DesktopDirectoryListing } from '../desktop-platform'
import { displayDirectoryPath, normalizeDirectoryPath, sortDirectoryDocuments } from '../desktop-directories'
import type { DirectorySortMode, PinnedDirectory } from '../desktop-directories'
import { filterCommands } from '../desktop-commands'
import type { DesktopCommand } from '../desktop-commands'
import '../App.css'
export function CommandPalette({ commands, query, onQuery, onClose }: {
  commands: DesktopCommand[]
  query: string
  onQuery: (query: string) => void
  onClose: () => void
}) {
  const filtered = filterCommands(commands, query)
  return (
    <div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <label><Command size={18} /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="输入命令名称" /></label>
        <div role="listbox">
          {filtered.map((command) => (
            <button key={command.id} type="button" onClick={() => { onClose(); void command.run() }}><span>{command.title}</span><kbd>{command.shortcut}</kbd></button>
          ))}
          {filtered.length === 0 && <p>没有匹配的命令</p>}
        </div>
      </section>
    </div>
  )
}
export function TextReader({ content }: { content: string }) {
  return <pre className="source-view">{content}</pre>
}

export function HtmlReader({
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

export function OpenErrorState({
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

export function LoadingState() {
  return (
    <section className="page page-loading" aria-label="加载中">
      <div className="loading-panel">
        <Loader2 size={32} className="loading-spinner" />
        <p>正在打开...</p>
      </div>
    </section>
  )
}

export class RenderErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode; onError?: (error: Error, info: React.ErrorInfo) => void },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error, info: React.ErrorInfo) { this.props.onError?.(error, info) }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

export function EmptyState({ tab }: { tab: HomeTab }) {
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

export type BottomNavProps = {
  currentView: View
  hasReader: boolean
  pinnedDirectories: PinnedDirectory[]
  activeDirectoryPath?: string
  onNavigate: (view: View) => void
  onBrowseDirectory: (directory: PinnedDirectory) => void
  onRemoveDirectory: (directory: PinnedDirectory) => void
}

export function BottomNav({ currentView, hasReader, pinnedDirectories, activeDirectoryPath, onNavigate, onBrowseDirectory, onRemoveDirectory }: BottomNavProps) {
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
      {pinnedDirectories.length > 0 && (
        <div className="pinned-directory-list desktop-only" aria-label="收藏目录">
          {pinnedDirectories.map((directory) => (
            <div className="pinned-directory-item" key={directory.id}>
              <button
                className={activeDirectoryPath && normalizeDirectoryPath(activeDirectoryPath) === normalizeDirectoryPath(directory.path) ? 'active' : ''}
                type="button"
                title={displayDirectoryPath(directory.path)}
                aria-label={`查看目录 ${directory.name}`}
                onClick={() => onBrowseDirectory(directory)}
              >
                <FolderOpen size={19} />
                <span>{directory.name}</span>
              </button>
              <button
                className="pinned-directory-remove"
                type="button"
                title={`取消收藏：${displayDirectoryPath(directory.path)}`}
                aria-label={`取消收藏目录 ${directory.name}`}
                onClick={() => onRemoveDirectory(directory)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}

export function DirectoryBrowserPopover({ listing, activeDocumentPath, sortMode, onOpen, onClose, onSortModeChange }: {
  listing: DesktopDirectoryListing
  activeDocumentPath?: string
  sortMode: DirectorySortMode
  onOpen: (path: string) => void
  onClose: () => void
  onSortModeChange: (mode: DirectorySortMode) => void
}) {
  const activePath = activeDocumentPath?.replace(/\\/g, '/').toLocaleLowerCase()
  const sortedFiles = useMemo(() => sortDirectoryDocuments(listing.files, sortMode), [listing.files, sortMode])
  return (
    <aside className="directory-browser-popover desktop-only" aria-label={`目录 ${listing.name}`}>
      <header>
        <div><strong>{listing.name}</strong><small title={displayDirectoryPath(listing.path)}>{displayDirectoryPath(listing.path)}</small></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭目录"><X size={16} /></button>
      </header>
      <DirectorySortControl value={sortMode} onChange={onSortModeChange} />
      <div className="directory-browser-files">
        {listing.files.length === 0 && <p className="sheet-empty">目录中没有 Markdown 或 HTML 文档。</p>}
        {sortedFiles.map((file) => {
          const selected = file.path.replace(/\\/g, '/').toLocaleLowerCase() === activePath
          return (
            <button key={file.path} type="button" className={selected ? 'active' : ''} disabled={selected} title={file.path} onClick={() => onOpen(file.path)}>
              <FileText size={16} />
              <span><strong>{file.fileName}</strong><small>{directoryFileDetails(file)}</small></span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

export function DirectorySortControl({ value, onChange }: {
  value: DirectorySortMode
  onChange: (mode: DirectorySortMode) => void
}) {
  return (
    <label className="directory-sort-control">
      <span>排序</span>
      <select
        aria-label="目录文件排序方式"
        value={value}
        onChange={(event) => onChange(event.target.value as DirectorySortMode)}
      >
        <option value="name-asc">名称 A–Z</option>
        <option value="name-desc">名称 Z–A</option>
        <option value="modified-desc">最新修改</option>
        <option value="modified-asc">最早修改</option>
        <option value="size-desc">文件从大到小</option>
        <option value="size-asc">文件从小到大</option>
      </select>
    </label>
  )
}

export function DesktopPopover({
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

export function Sheet({
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

export function PasteOpenDialog({
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

export function MenuAction({
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

export function PermissionToggle({
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
