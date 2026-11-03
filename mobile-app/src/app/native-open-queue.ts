import type { NativeOpenRequest } from './types'

type Dependencies = {
  getRequests: () => Promise<NativeOpenRequest[]>
  open: (request: NativeOpenRequest) => Promise<boolean>
  acknowledge: (requestId: string) => Promise<void>
  onSettled: (failure: NativeOpenRequest | null) => void
}

/** Failed files remain durable, but cannot block newer external opens. */
export function createNativeOpenQueue(dependencies: Dependencies) {
  const failures = new Map<string, NativeOpenRequest>()
  let running: Promise<void> | undefined
  let requested = false
  let disposed = false

  const consume = async () => {
    let failure = [...failures.values()].at(-1) ?? null
    do {
      requested = false
      const requests = await dependencies.getRequests()
      if (disposed) return
      const pendingIds = new Set(requests.map((request) => request.requestId))
      for (const id of failures.keys()) if (!pendingIds.has(id)) failures.delete(id)
      for (const request of requests) {
        if (disposed) return
        if (failures.has(request.requestId)) continue
        try {
          if (request.error) throw new Error(request.error)
          if (!await dependencies.open(request)) throw new Error('文件未导入，临时文件已保留，可重试或丢弃。')
          if (disposed) return
          await dependencies.acknowledge(request.requestId)
          failure = null
        } catch (error) {
          failure = {
            ...request,
            error: error instanceof Error ? error.message : '外部打开请求处理失败',
          }
          failures.set(request.requestId, failure)
        }
      }
    } while (requested && !disposed)
    // A later successful open must stay visible instead of being covered by an old failure.
    if (!disposed) dependencies.onSettled(failure && failures.has(failure.requestId) ? failure : null)
  }

  const drain = () => {
    if (disposed) return Promise.resolve()
    requested = true
    if (!running) running = consume().finally(() => { running = undefined })
    return running
  }

  return {
    drain,
    retry(requestId: string) {
      failures.delete(requestId)
      return drain()
    },
    dispose() { disposed = true },
  }
}
