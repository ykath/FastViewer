export type DocumentType = 'markdown' | 'html' | 'text'

export type DocumentRecord = {
  id: string
  fileName: string
  fileExtension: string
  fileType: DocumentType
  fileSize: number
  sourceType: string
  sourceUri?: string
  content: string
  rawBase64?: string
  archiveRelativePath?: string
  archiveResources?: Record<string, string>
  archiveStorageId?: string
  resourceStorageId?: string
  encoding: string
  lastOpenedAt: string
  createdAt: string
  isFavorite: boolean
  inLibrary: boolean
  lastReadPosition: number
  lastReadHeadingId?: string
  lastReadProgress?: number
  trustedHtml?: boolean
  allowHtmlScripts?: boolean
  allowHtmlForms?: boolean
  allowHtmlPopups?: boolean
}

export type DocumentPayload = Pick<DocumentRecord, 'content' | 'rawBase64' | 'archiveResources'>

export type DocumentMetadata = Omit<DocumentRecord, 'content' | 'rawBase64' | 'archiveResources'> & {
  storageVersion: 2
  hasRawBase64: boolean
  hasArchiveResources: boolean
}
