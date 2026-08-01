import type { DocumentSession } from './domain-models'

type SessionListener = (sessions: DocumentSession[], activeSessionId: string | null) => void

export class DocumentSessionManager {
  private sessions = new Map<string, DocumentSession>()
  private activeSessionId: string | null = null
  private listeners = new Set<SessionListener>()
  private recentlyClosed: DocumentSession[] = []

  list() {
    return Array.from(this.sessions.values())
  }

  active() {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) ?? null : null
  }

  create(documentId: string, revision: string, capabilities: string[] = []) {
    const session: DocumentSession = {
      sessionId: crypto.randomUUID(),
      documentId,
      revision,
      status: 'loading',
      capabilities,
    }
    this.sessions.set(session.sessionId, session)
    this.activeSessionId = session.sessionId
    this.emit()
    return session
  }

  activate(sessionId: string) {
    if (!this.sessions.has(sessionId)) return
    this.activeSessionId = sessionId
    this.emit()
  }

  update(sessionId: string, patch: Partial<Omit<DocumentSession, 'sessionId'>>) {
    const current = this.sessions.get(sessionId)
    if (!current) return
    this.sessions.set(sessionId, { ...current, ...patch })
    this.emit()
  }

  close(sessionId: string) {
    const closed = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (closed) this.recentlyClosed = [closed, ...this.recentlyClosed.filter((item) => item.documentId !== closed.documentId)].slice(0, 10)
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions.keys().next().value ?? null
    }
    this.emit()
    return closed ?? null
  }

  closed() {
    return [...this.recentlyClosed]
  }

  reopenLast() {
    const session = this.recentlyClosed.shift()
    if (!session) return null
    this.sessions.set(session.sessionId, { ...session, dormant: false })
    this.activeSessionId = session.sessionId
    this.emit()
    return session
  }

  snapshot() {
    return {
      sessions: this.list(),
      activeSessionId: this.activeSessionId,
      recentlyClosed: this.recentlyClosed,
    }
  }

  restore(snapshot: { sessions: DocumentSession[]; activeSessionId: string | null; recentlyClosed?: DocumentSession[] }) {
    this.sessions = new Map(snapshot.sessions.map((session) => [session.sessionId, { ...session, dormant: true }]))
    this.activeSessionId = snapshot.activeSessionId && this.sessions.has(snapshot.activeSessionId)
      ? snapshot.activeSessionId
      : this.sessions.keys().next().value ?? null
    this.recentlyClosed = (snapshot.recentlyClosed ?? []).slice(0, 10)
    this.emit()
  }

  subscribe(listener: SessionListener) {
    this.listeners.add(listener)
    listener(this.list(), this.activeSessionId)
    return () => { this.listeners.delete(listener) }
  }

  private emit() {
    const sessions = this.list()
    this.listeners.forEach((listener) => listener(sessions, this.activeSessionId))
  }
}

export const documentSessions = new DocumentSessionManager()
