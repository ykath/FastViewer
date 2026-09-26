import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type { AnnotationAnchor } from '../domain-models'

export type View = 'home' | 'reader' | 'settings' | 'error' | 'loading'
export type HomeTab = 'recent' | 'favorite' | 'library'
export type FileSortMode = 'recent' | 'name' | 'size'
export type ReaderMode = 'rendered' | 'source'
export type ImageExportMode = 'visible' | 'full' | 'pages'
export type ShareCardTemplate = 'simple' | 'dark' | 'accent'

export type FileOpenErrorCode =
  | 'PERMISSION_EXPIRED'
  | 'FILE_NOT_FOUND'
  | 'NO_VIEWABLE_FILE'
  | 'UNSUPPORTED_TYPE'
  | 'ENCODING_FAILED'
  | 'FILE_TOO_LARGE'
  | 'ARCHIVE_FAILED'
  | 'RENDER_FAILED'
  | 'UNKNOWN'

export type FileOpenError = {
  code: FileOpenErrorCode
  message: string
}

export const FILE_SIZE_WARNING = 5 * 1024 * 1024
export const FILE_SIZE_DANGER = 10 * 1024 * 1024

export type ToastState = {
  message: string
  tone?: 'normal' | 'success' | 'warning'
}

export type ExternalFileResult = {
  hasFile?: boolean
  isArchive?: boolean
  uri?: string
  fileName?: string
  mimeType?: string
  base64Content?: string
  cachedPath?: string
  storageId?: string
  sha256?: string
  originalPath?: string
  content?: string
  size?: number
  error?: string
  errorCode?: string
  documents?: ExternalArchiveDocument[]
  resources?: Record<string, string | ExternalArchiveResource>
  requestId?: string
}

export type NativeOpenRequest = {
  requestId: string
  receivedAt: string | number
  fileName: string
  mimeType?: string
  size: number
  cachedPath: string
  sourceUri?: string
  isArchive: boolean
  error?: string
}

export type ExternalArchiveDocument = {
  fileName: string
  relativePath?: string
  archiveName?: string
  sourceUri?: string
  base64Content?: string
  cachedPath?: string
  size?: number
}

export type ExternalArchiveResource = {
  mimeType?: string
  path: string
  size?: number
}

export type NativeFileChunk = {
  base64Content: string
  bytesRead: number
  done: boolean
  size: number
}

export type NativeWindowLayout = {
  features: Array<{ left: number; top: number; right: number; bottom: number; separating: boolean; orientation: 'vertical' | 'horizontal' }>
}

export type FastViewerFilesPlugin = {
  getLaunchFile: () => Promise<ExternalFileResult>
  getPendingOpenRequests: () => Promise<{ requests: NativeOpenRequest[] }>
  resolveOpenRequest: (options: { requestId: string }) => Promise<ExternalFileResult>
  acknowledgeOpenRequest: (options: { requestId: string }) => Promise<{ removed: boolean }>
  discardOpenRequest: (options: { requestId: string }) => Promise<{ removed: boolean }>
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
  getStorageStatus: () => Promise<{ durableBytes: number; regenerableBytes: number; openQueueBytes: number; shareBytes: number; freeBytes: number }>
  clearRegenerableCache: (options: { limitMb: number; force?: boolean }) => Promise<{ deleted: number; remainingBytes: number }>
  openArchiveEntry: (options: { storageId: string; relativePath: string }) => Promise<{ cachedPath: string; size: number }>
  getArchiveResources: (options: { storageId: string }) => Promise<{ resources: Record<string, ExternalArchiveResource> }>
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
  setVolumePageEnabled: (options: { enabled: boolean }) => Promise<void>
  setSelectionActionsEnabled: (options: { enabled: boolean }) => Promise<void>
  copyRichText: (options: { label: string; html: string; text: string }) => Promise<void>
  prepareShareCache: (options: { expectedBytes: number }) => Promise<{ availableBytes: number }>
  addListener: (
    eventName: 'fileOpen' | 'openRequestAvailable' | 'volumePage' | 'layoutChanged',
    listenerFunc: (result: ExternalFileResult | { count: number } | { direction: 'previous' | 'next' } | NativeWindowLayout) => void,
  ) => Promise<PluginListenerHandle>
}

export const FastViewerFiles = registerPlugin<FastViewerFilesPlugin>('FastViewerFiles')

export type NativeSelectionAction = 'highlight' | 'note' | 'card'

export type ReaderSelectionAction = {
  anchor: AnnotationAnchor
  x: number
  y: number
}

export const SETTINGS_KEY = 'lightpage.settings.v1'
