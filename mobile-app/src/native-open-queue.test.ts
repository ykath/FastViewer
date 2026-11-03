import { describe, expect, it, vi } from 'vitest'
import { createNativeOpenQueue } from './app/native-open-queue'
import type { NativeOpenRequest } from './app/types'

function request(requestId: string, fileName: string, error?: string): NativeOpenRequest {
  return { requestId, fileName, error, receivedAt: 0, size: 10, cachedPath: `/queue/${requestId}`, isArchive: fileName.endsWith('.rar') }
}

function fixture(initial: NativeOpenRequest[], open = vi.fn<(request: NativeOpenRequest) => Promise<boolean>>().mockResolvedValue(true)) {
  let pending = initial
  const acknowledge = vi.fn(async (id: string) => { pending = pending.filter((item) => item.requestId !== id) })
  const onSettled = vi.fn()
  const getRequests = vi.fn(async () => [...pending])
  const queue = createNativeOpenQueue({ getRequests, open, acknowledge, onSettled })
  return { queue, open, acknowledge, onSettled, getRequests, setPending: (items: NativeOpenRequest[]) => { pending = items } }
}

describe('Android 外部打开队列', () => {
  it('冷启动时旧 RAR 导入失败仍继续打开后续微信 Markdown，且不丢弃旧包', async () => {
    const rar = request('old', '旧压缩包.rar')
    const markdown = request('new', '微信文档.md')
    const open = vi.fn(async (item: NativeOpenRequest) => item.requestId !== 'old')
    const { queue, acknowledge, onSettled } = fixture([rar, markdown], open)
    await queue.drain()
    expect(open.mock.calls.map(([item]) => item.fileName)).toEqual(['旧压缩包.rar', '微信文档.md'])
    expect(acknowledge.mock.calls).toEqual([['new']])
    expect(onSettled).toHaveBeenLastCalledWith(null)
  })

  it('应用运行中到达的新文件跳过已失败项，不反复显示旧错误', async () => {
    const rar = request('old', '旧压缩包.rar')
    const open = vi.fn(async (item: NativeOpenRequest) => {
      if (item.requestId === 'old') throw new Error('RAR 解压失败')
      return true
    })
    const { queue, setPending, onSettled, acknowledge } = fixture([rar], open)
    await queue.drain()
    expect(onSettled).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'old', error: 'RAR 解压失败' }))
    setPending([rar, request('new', '新文档.md')])
    await queue.drain()
    expect(open.mock.calls.map(([item]) => item.requestId)).toEqual(['old', 'new'])
    expect(acknowledge.mock.calls).toEqual([['new']])
    expect(onSettled).toHaveBeenLastCalledWith(null)
  })

  it('暂存错误不阻塞后续文件，失败项可显式重试', async () => {
    const failed = request('failed', '文档.md', '权限失效')
    const { queue, open, setPending, onSettled } = fixture([failed, request('valid', '正文.md')])
    await queue.drain()
    expect(open.mock.calls.map(([item]) => item.requestId)).toEqual(['valid'])
    expect(onSettled).toHaveBeenLastCalledWith(null)
    setPending([{ ...failed, error: undefined }])
    await queue.retry('failed')
    expect(open.mock.calls.map(([item]) => item.requestId)).toEqual(['valid', 'failed'])
    expect(onSettled).toHaveBeenLastCalledWith(null)
  })

  it('导入后确认失败会保留文件，后续请求仍可处理', async () => {
    const { queue, acknowledge, onSettled } = fixture([request('first', '第一份.md'), request('second', '第二份.md')])
    acknowledge.mockRejectedValueOnce(new Error('确认失败'))
    await queue.drain()
    expect(acknowledge.mock.calls).toEqual([['first'], ['second']])
    expect(onSettled).toHaveBeenLastCalledWith(null)
  })

  it('最后一份文件失败时显示其重试入口', async () => {
    const { queue, onSettled } = fixture([request('good', '正文.md'), request('bad', '坏包.rar')], vi.fn(async (item) => item.requestId !== 'bad'))
    await queue.drain()
    expect(onSettled).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'bad' }))
  })

  it('处理期间收到通知会再次读取队列，保持串行且不漏掉新文件', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const first = request('first', '第一份.md')
    const second = request('second', '第二份.md')
    const open = vi.fn(async (item: NativeOpenRequest) => {
      if (item.requestId === 'first') await waiting
      return true
    })
    const { queue, setPending, acknowledge, getRequests } = fixture([first], open)
    const running = queue.drain()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    setPending([first, second])
    const signalled = queue.drain()
    expect(signalled).toBe(running)
    release()
    await running
    expect(getRequests).toHaveBeenCalledTimes(2)
    expect(open.mock.calls.map(([item]) => item.requestId)).toEqual(['first', 'second'])
    expect(acknowledge.mock.calls).toEqual([['first'], ['second']])
  })

  it('退出后不继续消费或更新界面', async () => {
    const { queue, open, onSettled } = fixture([request('file', '文件.md')])
    const running = queue.drain()
    queue.dispose()
    await running
    await queue.drain()
    expect(open).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })
})
