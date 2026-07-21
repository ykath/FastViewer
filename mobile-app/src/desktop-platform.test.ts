// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDesktopPlatform } from './desktop-platform'
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
    let listener: ((request: DesktopOpenRequest) => void) | undefined
    const calls: string[] = []
    const platform = createDesktopPlatform(createDependencies({
      listen: vi.fn(async (_event, handler) => {
        listener = handler
        return () => undefined
      }),
    }))

    await platform.listenForOpenRequests(async (request) => {
      await Promise.resolve()
      calls.push(request.fileName)
    })
    listener?.({ path: 'a.md', fileName: 'a.md', size: 1, source: 'association' })
    listener?.({ path: 'b.md', fileName: 'b.md', size: 1, source: 'association' })
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
})

