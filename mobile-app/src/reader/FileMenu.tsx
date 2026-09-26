import {
  Archive,
  Bookmark,
  Copy,
  FileCode2,
  Heart,
  ImageDown,
  MessageSquare,
  RefreshCw,
  Share2,
  ShieldCheck,
  Type,
  Upload,
} from 'lucide-react'
import type { DocumentRecord } from '../document-types'
import { MenuAction } from '../ui/chrome'
import type { ReaderMode } from '../app/types'

export function FileMenu({
  document,
  readerMode,
  isDesktop,
  annotationsCount,
  packageCount,
  exporting,
  onReload,
  onSaveToLibrary,
  onToggleFavorite,
  onToggleReaderMode,
  onCopyText,
  onCopyRichText,
  onAddBookmark,
  onOpenAnnotations,
  onExportAnnotations,
  onOpenPackage,
  onOpenHtmlPermissions,
  onOpenEncoding,
  onExportPdf,
  onOpenImageExport,
  onShareOriginal,
  renderFailed,
  onClose,
}: {
  document: DocumentRecord
  readerMode: ReaderMode
  isDesktop: boolean
  annotationsCount: number
  packageCount: number
  exporting: boolean
  renderFailed: boolean
  onReload?: () => Promise<boolean>
  onSaveToLibrary: () => void
  onToggleFavorite: () => void
  onToggleReaderMode: () => void
  onCopyText: () => void
  onCopyRichText: () => void
  onAddBookmark: () => void
  onOpenAnnotations: () => void
  onExportAnnotations: () => void
  onOpenPackage: () => void
  onOpenHtmlPermissions: () => void
  onOpenEncoding: () => void
  onExportPdf: () => void
  onOpenImageExport: () => void
  onShareOriginal: () => void
  onClose: () => void
}) {
  const closeThen = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <div className="menu-list">
      <MenuAction icon={<Archive size={18} />} label="保存到文件库" onClick={closeThen(onSaveToLibrary)} />
      <MenuAction
        icon={<Heart size={18} />}
        label={document.isFavorite ? '取消收藏' : '收藏'}
        onClick={closeThen(onToggleFavorite)}
      />
      <MenuAction
        icon={<FileCode2 size={18} />}
        label={readerMode === 'source' ? '查看阅读视图' : '查看源码'}
        onClick={closeThen(onToggleReaderMode)}
      />
      {isDesktop && onReload && (
        <MenuAction icon={<RefreshCw size={18} />} label="重新加载" onClick={closeThen(() => { void onReload() })} />
      )}
      <MenuAction icon={<Copy size={18} />} label="复制全文" onClick={closeThen(onCopyText)} />
      {document.fileType === 'markdown' && readerMode === 'rendered' && !renderFailed && (
        <MenuAction icon={<Copy size={18} />} label="复制富文本" onClick={closeThen(onCopyRichText)} />
      )}
      {document.fileType === 'markdown' && (
        <>
          <MenuAction icon={<Bookmark size={18} />} label="添加章节书签" onClick={closeThen(onAddBookmark)} />
          <MenuAction icon={<MessageSquare size={18} />} label={`批注与书签（${annotationsCount}）`} onClick={closeThen(onOpenAnnotations)} />
          <MenuAction icon={<Upload size={18} />} label="导出批注摘要" onClick={closeThen(onExportAnnotations)} />
        </>
      )}
      {packageCount > 0 && (
        <MenuAction icon={<Archive size={18} />} label="文档包目录" onClick={closeThen(onOpenPackage)} />
      )}
      {document.fileType === 'html' && (
        <MenuAction icon={<ShieldCheck size={18} />} label="HTML 权限" onClick={closeThen(onOpenHtmlPermissions)} />
      )}
      <MenuAction icon={<Type size={18} />} label="编码设置" onClick={closeThen(onOpenEncoding)} />
      <MenuAction icon={<Upload size={18} />} label={exporting ? '导出中...' : '导出 PDF'} onClick={onExportPdf} />
      <MenuAction
        icon={<ImageDown size={18} />}
        label={exporting ? '生成中...' : '分享图片'}
        onClick={closeThen(onOpenImageExport)}
      />
      <MenuAction
        icon={<Share2 size={18} />}
        label={exporting ? (isDesktop ? '导出中...' : '分享中...') : (isDesktop ? '导出原文件' : '分享原文件')}
        onClick={onShareOriginal}
      />
    </div>
  )
}
