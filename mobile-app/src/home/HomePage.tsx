import { type FileSortMode, type HomeTab } from '../app/types'
import { collapsePackageDocuments, formatBytes, formatTime } from '../app/records'
import { EmptyState } from '../ui/chrome'
import { Copy, FileCode2, FileText, FolderOpen, Search, ShieldCheck, Star, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DocumentRecord } from '../document-types'
import { displayDirectoryFromDocumentPath } from '../desktop-directories'
import '../App.css'
export type HomePageProps = {
  activeTab: HomeTab
  documents: DocumentRecord[]
  onTabChange: (tab: HomeTab) => void
  onOpenFile: (doc: DocumentRecord) => void
  onPickFile: () => void
  onPasteOpen: () => void
  onDelete: (doc: DocumentRecord) => void
  onRevealFile?: (doc: DocumentRecord) => void
  onClearTab: (tab: HomeTab) => void
  onToggleFavorite: (doc: DocumentRecord) => void
}

export function HomePage({
  activeTab,
  documents,
  onTabChange,
  onOpenFile,
  onPickFile,
  onPasteOpen,
  onDelete,
  onRevealFile,
  onClearTab,
  onToggleFavorite,
}: HomePageProps) {
  const [query, setQuery] = useState('')
  const [debouncedLibraryQuery, setDebouncedLibraryQuery] = useState('')
  const [sortMode, setSortMode] = useState<FileSortMode>('recent')
  const [visibleCount, setVisibleCount] = useState(50)
  const files = useMemo(() => {
    const normalizedQuery = debouncedLibraryQuery.trim().toLocaleLowerCase()
    const collapsed = collapsePackageDocuments(documents)
    const filtered = collapsed.filter((doc) => {
      if (activeTab === 'favorite' && !doc.isFavorite) return false
      if (activeTab === 'library' && !doc.inLibrary) return false
      return !normalizedQuery
        || (doc.packageName ?? doc.fileName).toLocaleLowerCase().includes(normalizedQuery)
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
          files.slice(0, visibleCount).map((file) => {
            const directoryPath = file.sourceUri ? displayDirectoryFromDocumentPath(file.sourceUri) : ''
            return (
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
                  <span className="file-name">{file.packageName ?? file.fileName}</span>
                  <span className="file-meta">
                    {file.sourceType} · {formatBytes(file.fileSize)} · {formatTime(file.lastOpenedAt)}
                  </span>
                  {directoryPath && (
                    <span className="file-directory" title={directoryPath}>
                      <FolderOpen size={12} />
                      <span>{directoryPath}</span>
                    </span>
                  )}
                </span>
                <span className="file-kind">{file.packageId ? '文档包' : file.fileExtension.toUpperCase()}</span>
              </button>
              <div className="file-row-actions">
                {directoryPath && onRevealFile && (
                  <button
                    className="row-action"
                    type="button"
                    aria-label={`在资源管理器中显示 ${file.fileName}`}
                    title={`在资源管理器中显示：${directoryPath}`}
                    onClick={() => onRevealFile(file)}
                  >
                    <FolderOpen size={16} />
                  </button>
                )}
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
            )
          })
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
