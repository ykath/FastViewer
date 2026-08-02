import type { DocumentRepository } from './domain-models'
import type { DesktopDirectoryDocument } from './desktop-platform'

export type DirectorySortMode =
  | 'name-asc'
  | 'name-desc'
  | 'modified-desc'
  | 'modified-asc'
  | 'size-desc'
  | 'size-asc'

export type PinnedDirectory = {
  id: string
  path: string
  name: string
  pinnedAt: string
}

const PINNED_DIRECTORIES_KEY = 'desktop-pinned-directories-v1'
const MAX_PINNED_DIRECTORIES = 12

export async function loadPinnedDirectories(repository: DocumentRepository): Promise<PinnedDirectory[]> {
  const stored = await repository.getAppState<unknown>(PINNED_DIRECTORIES_KEY)
  if (!Array.isArray(stored)) return []
  const seen = new Set<string>()
  return stored.filter(isPinnedDirectory).filter((item) => {
    const key = normalizeDirectoryPath(item.path)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_PINNED_DIRECTORIES)
}

export function savePinnedDirectories(repository: DocumentRepository, directories: PinnedDirectory[]) {
  return repository.setAppState(PINNED_DIRECTORIES_KEY, directories.slice(0, MAX_PINNED_DIRECTORIES))
}

export function pinDirectory(directories: PinnedDirectory[], path: string, name: string): PinnedDirectory[] {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized || directories.some((item) => normalizeDirectoryPath(item.path) === normalized)) return directories
  return [...directories, {
    id: directoryId(normalized),
    path: path.replace(/[\\/]+$/, ''),
    name: name || path.split(/[\\/]/).pop() || '目录',
    pinnedAt: new Date().toISOString(),
  }].slice(-MAX_PINNED_DIRECTORIES)
}

export function unpinDirectory(directories: PinnedDirectory[], path: string) {
  const normalized = normalizeDirectoryPath(path)
  return directories.filter((item) => normalizeDirectoryPath(item.path) !== normalized)
}

export function isDirectoryPinned(directories: PinnedDirectory[], path: string) {
  const normalized = normalizeDirectoryPath(path)
  return directories.some((item) => normalizeDirectoryPath(item.path) === normalized)
}

export function normalizeDirectoryPath(path: string) {
  return displayDirectoryPath(path).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase()
}

export function displayDirectoryPath(directoryPath: string) {
  let path = directoryPath.trim()
  if (/^\\\\\?\\UNC\\/i.test(path)) path = `\\\\${path.slice(8)}`
  else if (/^\\\\\?\\/.test(path)) path = path.slice(4)
  return path
}

export function displayDirectoryFromDocumentPath(documentPath: string) {
  const path = displayDirectoryPath(documentPath)
  const end = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return end > 0 ? path.slice(0, end) : ''
}

const directoryNameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
})

export function sortDirectoryDocuments(files: DesktopDirectoryDocument[], mode: DirectorySortMode) {
  return [...files].sort((left, right) => {
    if (mode.startsWith('name')) {
      const result = directoryNameCollator.compare(left.fileName, right.fileName)
      return mode.endsWith('desc') ? -result : result
    }
    const result = mode.startsWith('modified')
      ? (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0)
      : left.size - right.size
    if (result !== 0) return mode.endsWith('desc') ? -result : result
    return directoryNameCollator.compare(left.fileName, right.fileName)
  })
}

function directoryId(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `directory-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function isPinnedDirectory(value: unknown): value is PinnedDirectory {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PinnedDirectory>
  return typeof item.id === 'string'
    && typeof item.path === 'string'
    && typeof item.name === 'string'
    && typeof item.pinnedAt === 'string'
}
