import { invoke, isTauri } from '@tauri-apps/api/core'
import { Capacitor } from '@capacitor/core'
import { listen } from '@tauri-apps/api/event'
import { join } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import type {
  DesktopFileChange,
  WorkspaceIndexState,
  WorkspaceRecord,
  WorkspaceSearchHit,
  WorkspaceTreeNode,
} from './domain-models'
export { desktopDocumentId } from './desktop-identity'

export type DesktopOpenRequest = {
  path: string
  fileName: string
  size: number
  source: 'launch' | 'association' | 'picker' | 'workspace' | 'drop'
}

export type WorkspaceRegistration = Pick<WorkspaceRecord, 'id' | 'name' | 'rootPath' | 'exclusions'>
export type DesktopDropClassification = { files: DesktopOpenRequest[]; directories: string[]; rejected: number }

export type DesktopDirectoryDocument = {
  path: string
  fileName: string
  size: number
}

export type DesktopDirectoryListing = {
  path: string
  name: string
  files: DesktopDirectoryDocument[]
}

export type DesktopImageFile = {
  fileName: string
  bytes: Uint8Array
}

type UnlistenFn = () => void
type RelativeResourcePaths = Record<string, string>

const MAX_RELATIVE_IMAGES = 64

export type DesktopPlatformDependencies = {
  isTauri: () => boolean
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  listen: <T>(event: string, handler: (payload: T) => void) => Promise<UnlistenFn>
  openDialog: typeof open
  saveDialog: typeof save
  readFile: typeof readFile
  writeFile: typeof writeFile
  joinPath: typeof join
  openUrl: typeof openUrl
  revealItemInDir: typeof revealItemInDir
}

const defaultDependencies: DesktopPlatformDependencies = {
  isTauri,
  invoke,
  listen: <T>(event: string, handler: (payload: T) => void) =>
    listen<T>(event, ({ payload }) => handler(payload)),
  openDialog: open,
  saveDialog: save,
  readFile,
  writeFile,
  joinPath: join,
  openUrl,
  revealItemInDir,
}

export function createDesktopPlatform(dependencies: DesktopPlatformDependencies = defaultDependencies) {
  const isDesktop = () => dependencies.isTauri()

  const prepareRequest = (path: string, source: DesktopOpenRequest['source']) =>
    dependencies.invoke<DesktopOpenRequest>('prepare_open_request', { path, source })

  return {
    isDesktop,

    applyRuntimeMarker() {
      let runtime = isDesktop() ? 'desktop' : Capacitor.isNativePlatform() ? 'native' : 'web'
      if (import.meta.env.DEV) {
        const previewRuntime = new URLSearchParams(window.location.search).get('runtime')
        if (previewRuntime === 'desktop' || previewRuntime === 'native' || previewRuntime === 'web') {
          runtime = previewRuntime
        }
      }
      document.documentElement.dataset.runtime = runtime
    },

    async pickDocument(): Promise<DesktopOpenRequest | null> {
      if (!isDesktop()) return null
      const selected = await dependencies.openDialog({
        multiple: false,
        directory: false,
        title: '打开 Markdown 或 HTML 文件',
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
          { name: 'HTML', extensions: ['html', 'htm', 'xhtml'] },
        ],
      })
      if (!selected || Array.isArray(selected)) return null
      return prepareRequest(selected, 'picker')
    },

    async prepareDocument(path: string, source: DesktopOpenRequest['source'] = 'drop') {
      if (!isDesktop()) throw new Error('桌面文件接口不可用')
      return prepareRequest(path, source)
    },

    async pickWorkspaceDirectory(): Promise<string | null> {
      if (!isDesktop()) return null
      const selected = await dependencies.openDialog({
        multiple: false,
        directory: true,
        recursive: true,
        title: '选择资料目录',
      })
      return selected && !Array.isArray(selected) ? selected : null
    },

    async registerWorkspace(input: WorkspaceRegistration): Promise<WorkspaceRecord> {
      return dependencies.invoke<WorkspaceRecord>('register_workspace', { input })
    },

    async restoreWorkspaces(inputs: WorkspaceRegistration[]): Promise<WorkspaceRecord[]> {
      if (!isDesktop() || inputs.length === 0) return []
      return dependencies.invoke<WorkspaceRecord[]>('restore_workspaces', { inputs })
    },

    async removeWorkspace(workspaceId: string) {
      if (!isDesktop()) return
      await dependencies.invoke<void>('remove_workspace', { workspaceId })
    },

    async listWorkspaceChildren(workspaceId: string, relativePath = ''): Promise<WorkspaceTreeNode[]> {
      if (!isDesktop()) return []
      return dependencies.invoke<WorkspaceTreeNode[]>('list_workspace_children', { workspaceId, relativePath })
    },

    async openWorkspaceDocument(workspaceId: string, relativePath: string): Promise<DesktopOpenRequest> {
      return dependencies.invoke<DesktopOpenRequest>('prepare_workspace_open', { workspaceId, relativePath })
    },

    async startWorkspaceIndex(workspaceId: string) {
      await dependencies.invoke<void>('start_workspace_index', { workspaceId })
    },

    async cancelWorkspaceIndex(workspaceId: string) {
      await dependencies.invoke<void>('cancel_workspace_index', { workspaceId })
    },

    async searchWorkspaces(query: string, workspaceIds: string[], limit = 50): Promise<WorkspaceSearchHit[]> {
      if (!isDesktop()) return []
      return dependencies.invoke<WorkspaceSearchHit[]>('search_workspace', { query, workspaceIds, limit })
    },

    listenForWorkspaceIndex(handler: (state: WorkspaceIndexState) => void): Promise<UnlistenFn> {
      if (!isDesktop()) return Promise.resolve(() => undefined)
      return dependencies.listen<WorkspaceIndexState>('workspace-index-progress', handler)
    },

    listenForWorkspaceChanges(handler: (workspaceId: string) => void): Promise<UnlistenFn> {
      if (!isDesktop()) return Promise.resolve(() => undefined)
      return dependencies.listen<string>('workspace-files-changed', handler)
    },

    readDocument(request: DesktopOpenRequest) {
      return dependencies.readFile(request.path)
    },

    async loadMarkdownResources(documentPath: string, content: string): Promise<Record<string, string>> {
      if (!isDesktop()) return {}
      const sources = extractLocalMarkdownImageSources(content).slice(0, MAX_RELATIVE_IMAGES)
      if (sources.length === 0) return {}
      const resolved = await dependencies.invoke<RelativeResourcePaths>('resolve_relative_resources', {
        documentPath,
        relativePaths: sources,
      })
      const resources = await Promise.all(Object.entries(resolved).map(async ([source, path]) => {
        const bytes = await dependencies.readFile(path)
        return [normalizeResourceKey(source), bytesToImageDataUrl(bytes, path)] as const
      }))
      return Object.fromEntries(resources)
    },

    async resolveMarkdownResourcePaths(documentPath: string, content: string): Promise<string[]> {
      if (!isDesktop()) return []
      const sources = extractLocalMarkdownImageSources(content).slice(0, MAX_RELATIVE_IMAGES)
      if (sources.length === 0) return []
      const resolved = await dependencies.invoke<RelativeResourcePaths>('resolve_relative_resources', {
        documentPath,
        relativePaths: sources,
      })
      return Object.values(resolved)
    },

    async watchDocument(documentId: string, documentPath: string, resourcePaths: string[] = []) {
      if (!isDesktop()) return
      await dependencies.invoke<void>('watch_document', { documentId, documentPath, resourcePaths })
    },

    async unwatchDocument(documentId: string) {
      if (!isDesktop()) return
      await dependencies.invoke<void>('unwatch_document', { documentId })
    },

    listenForFileChanges(handler: (change: DesktopFileChange) => void): Promise<UnlistenFn> {
      if (!isDesktop()) return Promise.resolve(() => undefined)
      return dependencies.listen<DesktopFileChange>('desktop-file-changed', handler)
    },

    async listenForDrops(handler: (paths: string[]) => void): Promise<UnlistenFn> {
      if (!isDesktop()) return () => undefined
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      return getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') handler(event.payload.paths)
      })
    },

    async classifyDropPaths(paths: string[]): Promise<DesktopDropClassification> {
      if (!isDesktop()) return { files: [], directories: [], rejected: paths.length }
      return dependencies.invoke<DesktopDropClassification>('classify_drop_paths', { paths })
    },

    async listDirectoryDocuments(path: string): Promise<DesktopDirectoryListing> {
      if (!isDesktop()) return { path: '', name: '', files: [] }
      return dependencies.invoke<DesktopDirectoryListing>('list_directory_documents', { path })
    },

    async takePendingOpenRequests(): Promise<DesktopOpenRequest[]> {
      if (!isDesktop()) return []
      return dependencies.invoke<DesktopOpenRequest[]>('take_pending_open_requests')
    },

    async listenForOpenRequests(handler: (request: DesktopOpenRequest) => Promise<void> | void): Promise<UnlistenFn> {
      if (!isDesktop()) return () => undefined
      let chain = Promise.resolve()
      return dependencies.listen<void>('desktop-open-requested', () => {
        chain = chain.then(async () => {
          const requests = await dependencies.invoke<DesktopOpenRequest[]>('take_pending_open_requests')
          for (const request of requests) {
            await handler(request)
          }
        }).catch(() => undefined)
      })
    },

    async saveOriginal(bytes: Uint8Array, fileName: string): Promise<boolean> {
      if (!isDesktop()) return false
      const extension = fileName.includes('.') ? fileName.split('.').pop() ?? '' : ''
      const path = await dependencies.saveDialog({
        title: '导出原文件',
        defaultPath: fileName,
        filters: extension ? [{ name: '原文件', extensions: [extension] }] : undefined,
      })
      if (!path) return false
      await dependencies.writeFile(path, bytes)
      return true
    },

    async saveImages(images: DesktopImageFile[]): Promise<boolean> {
      if (!isDesktop() || images.length === 0) return false
      if (images.length === 1) {
        const path = await dependencies.saveDialog({
          title: '导出图片',
          defaultPath: images[0].fileName,
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        })
        if (!path) return false
        await dependencies.writeFile(path, images[0].bytes)
        return true
      }

      const directory = await dependencies.openDialog({
        directory: true,
        multiple: false,
        recursive: false,
        title: '选择分页图片保存目录',
      })
      if (!directory || Array.isArray(directory)) return false
      for (const image of images) {
        await dependencies.writeFile(await dependencies.joinPath(directory, image.fileName), image.bytes)
      }
      return true
    },

    async openExternalLink(url: string): Promise<void> {
      if (!/^https?:\/\//i.test(url)) return
      if (isDesktop()) {
        await dependencies.openUrl(url)
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    },

    async revealInFileManager(path: string): Promise<boolean> {
      if (!isDesktop() || !path) return false
      await dependencies.revealItemInDir(path)
      return true
    },

    async getHtmlOpenWith(): Promise<boolean> {
      if (!isDesktop()) return false
      return dependencies.invoke<boolean>('get_html_open_with')
    },

    async setHtmlOpenWith(enabled: boolean): Promise<boolean> {
      if (!isDesktop()) return false
      return dependencies.invoke<boolean>('set_html_open_with', { enabled })
    },

    async addRecentDocument(path: string): Promise<void> {
      if (!isDesktop()) return
      await dependencies.invoke<void>('add_recent_document', { path })
    },
  }
}

export const desktopPlatform = createDesktopPlatform()

export function extractLocalMarkdownImageSources(content: string) {
  const sources: string[] = []
  const seen = new Set<string>()
  const imagePattern = /!\[[^\]]*]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+["'][^"'\r\n]*["'])?\s*\)/g
  for (const match of content.matchAll(imagePattern)) {
    const source = (match[1] ?? match[2] ?? '').trim()
    const localPath = decodeLocalResourcePath(source)
    if (!localPath || seen.has(localPath)) continue
    seen.add(localPath)
    sources.push(localPath)
  }
  return sources
}

function decodeLocalResourcePath(source: string) {
  const pathOnly = source.split(/[?#]/, 1)[0]
  if (!pathOnly || /^(?:[a-z][a-z\d+.-]*:|\/\/|[\\/])/i.test(pathOnly)) return ''
  try {
    return decodeURIComponent(pathOnly)
  } catch {
    return pathOnly
  }
}

function normalizeResourceKey(source: string) {
  const normalized: string[] = []
  for (const part of source.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return normalized.join('/').toLowerCase()
}

function bytesToImageDataUrl(bytes: Uint8Array, path: string) {
  const extension = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase()
  const mimeType = extension === 'png'
    ? 'image/png'
    : extension === 'gif'
      ? 'image/gif'
      : extension === 'webp'
        ? 'image/webp'
        : 'image/jpeg'
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}
