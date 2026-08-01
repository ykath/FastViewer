import type { DocumentRepository } from './domain-models'

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
  return path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase()
}

export function displayDirectoryFromDocumentPath(documentPath: string) {
  let path = documentPath.trim()
  if (/^\\\\\?\\UNC\\/i.test(path)) path = `\\\\${path.slice(8)}`
  else if (/^\\\\\?\\/.test(path)) path = path.slice(4)
  const end = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return end > 0 ? path.slice(0, end) : ''
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
