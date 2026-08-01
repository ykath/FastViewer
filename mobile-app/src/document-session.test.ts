import { describe, expect, it } from 'vitest'
import { DocumentSessionManager } from './document-session'

describe('多文档会话管理器', () => {
  it('创建、切换、更新和关闭多个独立会话', () => {
    const manager = new DocumentSessionManager()
    const first = manager.create('doc-a', 'r1', ['read'])
    const second = manager.create('doc-b', 'r2', ['read', 'search'])
    expect(manager.active()?.sessionId).toBe(second.sessionId)
    manager.activate(first.sessionId)
    manager.update(first.sessionId, { status: 'ready' })
    expect(manager.active()).toMatchObject({ documentId: 'doc-a', status: 'ready' })
    manager.close(first.sessionId)
    expect(manager.active()?.documentId).toBe('doc-b')
  })
})
