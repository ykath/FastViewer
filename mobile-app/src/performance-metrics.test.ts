// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finishPerformanceSpan, readPerformanceMetrics } from './performance-metrics'

describe('本地性能指标', () => {
  beforeEach(() => localStorage.clear())

  it('记录耗时与上下文且限制为最近 100 条', () => {
    vi.spyOn(performance, 'now').mockReturnValue(120)
    finishPerformanceSpan('file-open', 20, { bytes: 1024 })
    expect(readPerformanceMetrics()[0]).toMatchObject({ name: 'file-open', durationMs: 100, detail: { bytes: 1024 } })
    vi.restoreAllMocks()
  })
})
