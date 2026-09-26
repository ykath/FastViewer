import { FastViewerFiles, SETTINGS_KEY } from './types'
import { useEffect, useState } from 'react'
import { base64ToBytes } from '../encoding'
import type { DocumentRecord, DocumentType } from '../document-types'
import { useDocumentStore } from '../use-document-store'
import { DEFAULT_READER_SETTINGS } from '../reader-settings'
import type { ReaderSettings } from '../reader-settings'
import type { DesktopDirectoryDocument } from '../desktop-platform'

export const sampleMarkdown = `# 手机端 Markdown / HTML 阅读器

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

export const seedDocuments: DocumentRecord[] = [
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
export function usePersistentDocuments() {
  return useDocumentStore(seedDocuments)
}

export function usePersistentSettings() {
  return usePersistentState<ReaderSettings>(SETTINGS_KEY, DEFAULT_READER_SETTINGS)
}

export function usePersistentState<T>(key: string, initialValue: T) {
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

export function createRecordFromBytes({
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

export function createRecordFromContent({
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

export function upsertDocument(items: DocumentRecord[], doc: DocumentRecord) {
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

export function sortDocuments(items: DocumentRecord[]) {
  return [...items].sort(
    (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime(),
  )
}

export function comparePackageDocuments(left: DocumentRecord, right: DocumentRecord) {
  const leftPath = (left.archiveRelativePath ?? left.fileName).replace(/\\/g, '/')
  const rightPath = (right.archiveRelativePath ?? right.fileName).replace(/\\/g, '/')
  const priority = (path: string) => {
    const name = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
    if (name === 'readme.md' || name === 'readme.markdown') return 0
    if (name === 'index.md' || name === 'index.markdown' || name === 'index.html' || name === 'index.htm') return 1
    return 2
  }
  return priority(leftPath) - priority(rightPath)
    || leftPath.localeCompare(rightPath, undefined, { numeric: true, sensitivity: 'base' })
}

export function collapsePackageDocuments(items: DocumentRecord[]) {
  const packages = new Map<string, DocumentRecord[]>()
  const standalone: DocumentRecord[] = []
  items.forEach((item) => {
    if (!item.packageId) {
      standalone.push(item)
      return
    }
    const entries = packages.get(item.packageId) ?? []
    entries.push(item)
    packages.set(item.packageId, entries)
  })
  const collapsed = Array.from(packages.values()).map((entries) => {
    const representative = [...entries].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))[0]
    return {
      ...representative,
      fileSize: entries.reduce((total, item) => total + item.fileSize, 0),
      isFavorite: entries.some((item) => item.isFavorite),
      inLibrary: entries.some((item) => item.inLibrary),
    }
  })
  return [...standalone, ...collapsed]
}

export function getExtension(fileName: string) {
  return fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? '' : ''
}

export function isArchiveFileName(fileName: string) {
  return ['zip', 'rar'].includes(getExtension(fileName))
}

export function inferFileType(fileName: string): DocumentType {
  const extension = getExtension(fileName)
  if (['md', 'markdown', 'mdown'].includes(extension)) return 'markdown'
  if (['html', 'htm', 'xhtml'].includes(extension)) return 'html'
  return 'text'
}

export function looksLikeHtml(content: string) {
  const sample = content.trim().slice(0, 4096)
  return /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(sample)
    || /<(?:article|section|main|div|p|h[1-6]|table|style)(?:\s[^>]*)?>/i.test(sample)
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

export async function readNativeStoredFile(path: string, expectedSize?: number) {
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

export function resetViewportScroll() {
  window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

export function stableDocumentId(fileName: string, content: string) {
  let hash = 0
  const input = `${fileName}:${content.slice(0, 2048)}:${content.length}`
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }
  return `${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}-${Math.abs(hash)}`
}

export function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value]) => right?.[key] === value)
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function directoryFileDetails(file: DesktopDirectoryDocument) {
  if (!file.modifiedAt) return formatBytes(file.size)
  const modified = new Date(file.modifiedAt)
  if (Number.isNaN(modified.getTime())) return formatBytes(file.size)
  const modifiedText = modified.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `${formatBytes(file.size)} · ${modifiedText}`
}

export function inferDocumentMime(document: DocumentRecord) {
  if (document.fileType === 'html') return 'text/html'
  if (document.fileType === 'markdown') return 'text/markdown'
  return 'text/plain'
}

export function formatTime(value: string) {
  const date = new Date(value)
  const diff = Date.now() - date.getTime()
  if (Number.isNaN(diff)) return '未知时间'
  if (diff < 1000 * 60 * 60) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`
  if (diff < 1000 * 60 * 60 * 24) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 1000 * 60 * 60 * 24 * 7) return `${Math.floor(diff / 86400000)} 天前`
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function splitShareCardText(value: string, maxLength: number) {
  const text = value.trim()
  if (!text) return []
  const pages: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const sample = remaining.slice(0, maxLength + 1)
    const boundary = Math.max(sample.lastIndexOf('\n'), sample.lastIndexOf('。'), sample.lastIndexOf('；'), sample.lastIndexOf(' '))
    const end = boundary >= Math.floor(maxLength * 0.55) ? boundary + 1 : maxLength
    pages.push(remaining.slice(0, end).trim())
    remaining = remaining.slice(end).trim()
  }
  if (remaining) pages.push(remaining)
  return pages
}

