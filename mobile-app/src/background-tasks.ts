import type { BackgroundTask } from './domain-models'

type TaskListener = (tasks: BackgroundTask[]) => void

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>()
  private controllers = new Map<string, AbortController>()
  private listeners = new Set<TaskListener>()

  begin(type: BackgroundTask['type'], message?: string) {
    const task: BackgroundTask = {
      id: crypto.randomUUID(),
      type,
      status: 'running',
      progress: 0,
      message,
    }
    const controller = new AbortController()
    this.tasks.set(task.id, task)
    this.controllers.set(task.id, controller)
    this.emit()
    return { task, signal: controller.signal }
  }

  update(id: string, patch: Partial<Pick<BackgroundTask, 'progress' | 'message'>>) {
    const current = this.tasks.get(id)
    if (!current || current.status !== 'running') return
    this.tasks.set(id, { ...current, ...patch, progress: Math.max(0, Math.min(1, patch.progress ?? current.progress)) })
    this.emit()
  }

  cancel(id: string) {
    const current = this.tasks.get(id)
    if (!current || !['queued', 'running'].includes(current.status)) return false
    this.controllers.get(id)?.abort()
    this.tasks.set(id, { ...current, status: 'cancelled' })
    this.controllers.delete(id)
    this.emit()
    return true
  }

  complete(id: string) {
    this.finish(id, { status: 'complete', progress: 1 })
  }

  fail(id: string, error: string) {
    this.finish(id, { status: 'failed', error })
  }

  list() {
    return Array.from(this.tasks.values())
  }

  subscribe(listener: TaskListener) {
    this.listeners.add(listener)
    listener(this.list())
    return () => { this.listeners.delete(listener) }
  }

  private finish(id: string, patch: Partial<BackgroundTask>) {
    const current = this.tasks.get(id)
    if (!current) return
    this.tasks.set(id, { ...current, ...patch })
    this.controllers.delete(id)
    this.emit()
  }

  private emit() {
    const tasks = this.list()
    this.listeners.forEach((listener) => listener(tasks))
  }
}

export const backgroundTasks = new BackgroundTaskManager()
