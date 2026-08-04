export type DocumentType = 'markdown' | 'html' | 'text'

export type DocumentRecord = {
  id: string
  fileName: string
  fileExtension: string
  fileType: DocumentType
  fileSize: number
  sourceType: string
  sourceUri?: string
  sourceUrl?: string
  sourceAdapter?: 'generic' | 'x' | 'youtube' | 'hn' | string
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
  packageId?: string
  packageName?: string
  contentRevision?: string
  payloadLoaded?: boolean
}

export type DocumentPayload = Pick<DocumentRecord, 'content' | 'rawBase64' | 'archiveResources'>

export type DocumentMetadata = Omit<DocumentRecord, 'content' | 'rawBase64' | 'archiveResources'> & {
  storageVersion: 2 | 3 | 4
  hasRawBase64: boolean
  hasArchiveResources: boolean
}
