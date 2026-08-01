import { describe, expect, it } from 'vitest'
import { BackgroundTaskManager } from './background-tasks'

describe('后台任务管理器', () => {
  it('支持进度、取消和完成状态', () => {
    const manager = new BackgroundTaskManager()
    const first = manager.begin('image-export')
    manager.update(first.task.id, { progress: 0.5 })
    expect(manager.list()[0].progress).toBe(0.5)
    expect(manager.cancel(first.task.id)).toBe(true)
    expect(first.signal.aborted).toBe(true)
    const second = manager.begin('pdf-export')
    manager.complete(second.task.id)
    expect(manager.list().at(-1)?.status).toBe('complete')
  })
})
