import type { DocumentRepository, WorkspaceRecord } from './domain-models'

const WORKSPACES_KEY = 'desktop-workspaces-v1'
const DEFAULT_EXCLUSIONS = ['.git', '.svn', 'node_modules', 'target', 'dist', 'build']

export async function loadWorkspaceRecords(repository: DocumentRepository): Promise<WorkspaceRecord[]> {
  const stored = await repository.getAppState<WorkspaceRecord[]>(WORKSPACES_KEY)
  if (!Array.isArray(stored)) return []
  return stored.filter(isWorkspaceRecord).map((item) => ({
    ...item,
    exclusions: Array.from(new Set([...DEFAULT_EXCLUSIONS, ...item.exclusions])),
    expandedPaths: Array.isArray(item.expandedPaths) ? item.expandedPaths : [],
  }))
}

export function saveWorkspaceRecords(repository: DocumentRepository, records: WorkspaceRecord[]) {
  return repository.setAppState(WORKSPACES_KEY, records.map((item) => ({
    ...item,
    expandedPaths: item.expandedPaths.slice(0, 500),
  })))
}

export function createWorkspaceRecord(rootPath: string): WorkspaceRecord {
  const normalized = rootPath.replace(/[\\/]+$/, '')
  const name = normalized.split(/[\\/]/).pop() || '资料目录'
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name,
    rootPath: normalized,
    status: 'online',
    exclusions: [...DEFAULT_EXCLUSIONS],
    expandedPaths: [],
    createdAt: now,
    updatedAt: now,
  }
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkspaceRecord>
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.rootPath === 'string'
    && Array.isArray(item.exclusions)
}
