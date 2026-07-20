export type PerformanceMetric = {
  name: string
  durationMs: number
  recordedAt: string
  detail?: Record<string, string | number | boolean>
}

const STORAGE_KEY = 'lightpage.performance.v1'
const MAX_ENTRIES = 100

export function startPerformanceSpan() {
  return performance.now()
}

export function finishPerformanceSpan(
  name: string,
  startedAt: number,
  detail?: PerformanceMetric['detail'],
) {
  const metric: PerformanceMetric = {
    name,
    durationMs: Math.max(0, performance.now() - startedAt),
    recordedAt: new Date().toISOString(),
    detail,
  }
  try {
    const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as PerformanceMetric[]
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...previous.slice(-(MAX_ENTRIES - 1)), metric]))
  } catch {
    // 性能日志不能影响阅读主链路。
  }
  return metric
}

export function readPerformanceMetrics() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as PerformanceMetric[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
