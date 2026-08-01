// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDesktopPlatform, desktopDocumentId, extractLocalMarkdownImageSources } from './desktop-platform'
import type { DesktopOpenRequest, DesktopPlatformDependencies } from './desktop-platform'

function createDependencies(overrides: Partial<DesktopPlatformDependencies> = {}): DesktopPlatformDependencies {
  return {
    isTauri: () => true,
    invoke: vi.fn(async (command, args) => {
      if (command === 'take_pending_open_requests') return []
      return {
        path: args?.path,
        fileName: 'notes.md',
        size: 7,
        source: args?.source,
      }
    }) as DesktopPlatformDependencies['invoke'],
    listen: vi.fn(async () => () => undefined),
    openDialog: vi.fn(async () => null) as DesktopPlatformDependencies['openDialog'],
    saveDialog: vi.fn(async () => null),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    writeFile: vi.fn(async () => undefined),
    joinPath: vi.fn(async (...parts: string[]) => parts.join('/')),
    openUrl: vi.fn(async () => undefined),
    revealItemInDir: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('desktop platform adapter', () => {
  it('marks desktop and web runtimes without invoking native APIs', () => {
    const desktop = createDesktopPlatform(createDependencies())
    desktop.applyRuntimeMarker()
    expect(document.documentElement.dataset.runtime).toBe('desktop')

    const web = createDesktopPlatform(createDependencies({ isTauri: () => false }))
    web.applyRuntimeMarker()
    expect(document.documentElement.dataset.runtime).toBe('web')
  })

  it('returns null when the native file picker is cancelled', async () => {
    const platform = createDesktopPlatform(createDependencies())
    await expect(platform.pickDocument()).resolves.toBeNull()
  })

  it('validates a selected file through the Rust command before reading it', async () => {
    const invokeMock = vi.fn(async () => ({
      path: 'C:\\文档\\notes.md',
      fileName: 'notes.md',
      size: 7,
      source: 'picker',
    })) as DesktopPlatformDependencies['invoke']
    const platform = createDesktopPlatform(createDependencies({
      invoke: invokeMock,
      openDialog: vi.fn(async () => 'C:\\文档\\notes.md') as DesktopPlatformDependencies['openDialog'],
    }))

    const request = await platform.pickDocument()
    expect(request?.fileName).toBe('notes.md')
    expect(invokeMock).toHaveBeenCalledWith('prepare_open_request', {
      path: 'C:\\文档\\notes.md',
      source: 'picker',
    })
  })

  it('serializes file association events', async () => {
    let listener: (() => void) | undefined
    const calls: string[] = []
    const pendingBatches: DesktopOpenRequest[][] = [
      [{ path: 'a.md', fileName: 'a.md', size: 1, source: 'association' }],
      [{ path: 'b.md', fileName: 'b.md', size: 1, source: 'association' }],
    ]
    const platform = createDesktopPlatform(createDependencies({
      invoke: vi.fn(async (command) =>
        command === 'take_pending_open_requests' ? pendingBatches.shift() ?? [] : null,
      ) as DesktopPlatformDependencies['invoke'],
      listen: vi.fn(async (_event, handler) => {
        listener = handler
        return () => undefined
      }),
    }))

    await platform.listenForOpenRequests(async (request) => {
      await Promise.resolve()
      calls.push(request.fileName)
    })
    listener?.()
    listener?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['a.md', 'b.md'])
  })

  it('does not write files when an export dialog is cancelled', async () => {
    const writeFile = vi.fn(async () => undefined)
    const platform = createDesktopPlatform(createDependencies({ writeFile }))
    await expect(platform.saveOriginal(new Uint8Array([1]), 'notes.md')).resolves.toBe(false)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('opens only HTTP links through the system opener', async () => {
    const openUrlMock = vi.fn(async () => undefined)
    const platform = createDesktopPlatform(createDependencies({ openUrl: openUrlMock }))
    await platform.openExternalLink('javascript:alert(1)')
    await platform.openExternalLink('https://example.com')
    expect(openUrlMock).toHaveBeenCalledTimes(1)
  })

  it('reveals a local document through the system file manager', async () => {
    const revealItemInDir = vi.fn(async () => undefined)
    const platform = createDesktopPlatform(createDependencies({ revealItemInDir }))
    await expect(platform.revealInFileManager('\\\\?\\C:\\Docs\\notes.md')).resolves.toBe(true)
    expect(revealItemInDir).toHaveBeenCalledWith('\\\\?\\C:\\Docs\\notes.md')
  })

  it('extracts only local Markdown image paths', () => {
    expect(extractLocalMarkdownImageSources([
      '![首页](首页.jpg)',
      '![桌面](<windows/Windows%20首页.png>)',
      '![重复](首页.jpg)',
      '![远程](https://example.com/a.png)',
      '![数据](data:image/png;base64,AAAA)',
      '![绝对](/images/a.png)',
    ].join('\n'))).toEqual([
      '首页.jpg',
      'windows/Windows 首页.png',
    ])
  })

  it('loads approved relative images as persistent data URLs', async () => {
    const invokeMock = vi.fn(async (command) => {
      if (command === 'resolve_relative_resources') {
        return {
          '首页.jpg': 'C:\\文章\\首页.jpg',
          'windows/Windows-首页.png': 'C:\\文章\\windows\\Windows-首页.png',
        }
      }
      return []
    }) as DesktopPlatformDependencies['invoke']
    const readFile = vi.fn(async (path: string | URL) =>
      String(path).endsWith('.png') ? new Uint8Array([137, 80, 78, 71]) : new Uint8Array([255, 216, 255]),
    )
    const platform = createDesktopPlatform(createDependencies({
      invoke: invokeMock,
      readFile,
    }))

    const resources = await platform.loadMarkdownResources(
      'C:\\文章\\使用说明.md',
      '![首页](首页.jpg)\n![Windows](windows/Windows-首页.png)',
    )

    expect(invokeMock).toHaveBeenCalledWith('resolve_relative_resources', {
      documentPath: 'C:\\文章\\使用说明.md',
      relativePaths: ['首页.jpg', 'windows/Windows-首页.png'],
    })
    expect(resources['首页.jpg']).toMatch(/^data:image\/jpeg;base64,/)
    expect(resources['windows/windows-首页.png']).toMatch(/^data:image\/png;base64,/)
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('uses a stable case-insensitive identity for Windows paths', () => {
    expect(desktopDocumentId('C:\\Docs\\Guide.md')).toBe(desktopDocumentId('c:/docs/guide.md'))
    expect(desktopDocumentId('C:\\Docs\\Other.md')).not.toBe(desktopDocumentId('C:\\Docs\\Guide.md'))
  })
})
