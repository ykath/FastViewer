import type { DocumentMetadata, DocumentType } from './document-types'

export type ContentRef =
  | { kind: 'android-private-file'; path: string }
  | { kind: 'android-archive-entry'; packageId: string; relativePath: string }
  | { kind: 'indexeddb-blob'; key: string }
  | { kind: 'desktop-file'; path: string; fingerprint?: string }

export type ReaderState = {
  documentId: string
  position: number
  progress: number
  headingId?: string
  updatedAt: string
}

export type AnnotationKind = 'highlight' | 'note' | 'bookmark'
export type AnnotationStatus = 'active' | 'orphaned'

export type AnnotationAnchor = {
  revision: string
  start: number
  end: number
  exact: string
  prefix: string
  suffix: string
  headingId?: string
}

export type DocumentAnnotation = {
  id: string
  documentId: string
  kind: AnnotationKind
  anchor: AnnotationAnchor
  note?: string
  color: 'yellow'
  status: AnnotationStatus
  createdAt: string
  updatedAt: string
}

export type ArchivePackage = {
  id: string
  fileName: string
  sha256?: string
  sourceUri?: string
  storageId: string
  originalAvailable: boolean
  durableExtraction: boolean
  lastEntryId?: string
  createdAt: string
  lastOpenedAt: string
  totalSize: number
}

export type PackageEntry = {
  id: string
  packageId: string
  documentId: string
  relativePath: string
  fileName: string
  fileType: DocumentType
  size: number
  order: number
  isFavorite: boolean
}

export type DocumentSessionStatus = 'loading' | 'ready' | 'failed'

export type DocumentSession = {
  sessionId: string
  documentId: string
  revision: string
  status: DocumentSessionStatus
  capabilities: string[]
  error?: string
}

export type MigrationStage = 'pending' | 'running' | 'verified' | 'complete' | 'failed'

export type MigrationResult = {
  stage: MigrationStage
  migratedDocuments: number
  migratedPackages: number
  readonlyFallback: boolean
  error?: string
}

export type ContentStat = {
  size: number
  modifiedAt?: string
}

export type OpenSource = {
  fileName: string
  bytes?: Uint8Array
  cachedPath?: string
  desktopPath?: string
}

export type OpenRequest = {
  requestId: string
  receivedAt: string
  fileName: string
  mimeType?: string
  size: number
  cachedPath: string
  sourceUri?: string
  isArchive: boolean
  error?: string
}

export type StoredDocumentMetadata = DocumentMetadata & {
  contentRef: ContentRef
}

export interface DocumentRepository {
  migrate(): Promise<MigrationResult>
  listDocuments(): Promise<StoredDocumentMetadata[]>
  getDocument(id: string): Promise<StoredDocumentMetadata | null>
  saveDocument(document: StoredDocumentMetadata): Promise<void>
  deleteDocument(id: string): Promise<void>
  getReaderState(documentId: string): Promise<ReaderState | null>
  saveReaderState(state: ReaderState): Promise<void>
  listAnnotations(documentId: string): Promise<DocumentAnnotation[]>
  saveAnnotation(annotation: DocumentAnnotation): Promise<void>
  deleteAnnotation(id: string): Promise<void>
  getPackage(id: string): Promise<ArchivePackage | null>
  savePackage(item: ArchivePackage): Promise<void>
  deletePackage(id: string): Promise<void>
  listPackageEntries(packageId: string): Promise<PackageEntry[]>
  savePackageEntries(entries: PackageEntry[]): Promise<void>
}

export interface ContentSourceAdapter {
  stat(ref: ContentRef): Promise<ContentStat>
  readChunks(ref: ContentRef, signal: AbortSignal): AsyncIterable<Uint8Array>
  resolveResources(ref: ContentRef, paths: string[]): Promise<Record<string, string>>
  persistOriginal(source: OpenSource): Promise<ContentRef>
  release(ref: ContentRef): Promise<void>
}

export interface OpenRequestQueue {
  listPending(): Promise<OpenRequest[]>
  acknowledge(requestId: string): Promise<void>
  discard(requestId: string): Promise<void>
  subscribe(listener: () => void): Promise<() => void>
}
