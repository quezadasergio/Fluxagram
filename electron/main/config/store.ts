import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import type { AppConfigData, ColumnConfig, SessionRecord } from '../../../shared/types'
import { cookiesFile, loadConfig, saveConfig, sessionDir } from './paths'

export class SessionStore {
  private config: AppConfigData

  constructor() {
    this.config = loadConfig()
    this.removeIncompleteSessions()
  }

  getConfig(): AppConfigData {
    return this.config
  }

  reload(): AppConfigData {
    this.config = loadConfig()
    return this.config
  }

  save(): void {
    saveConfig(this.config)
  }

  sessions(): SessionRecord[] {
    return this.config.sessions
  }

  loggedInSessions(): SessionRecord[] {
    return this.config.sessions.filter((s) => s.username && s.username.trim().length > 0)
  }

  hasLoggedInSession(): boolean {
    return this.loggedInSessions().length > 0
  }

  findSession(id: string): SessionRecord | undefined {
    return this.config.sessions.find((s) => s.id === id)
  }

  createNew(): SessionRecord {
    const record: SessionRecord = { id: uuidv4(), username: '' }
    this.config.sessions.push(record)
    this.save()
    return record
  }

  setUsername(sessionId: string, username: string): void {
    const session = this.findSession(sessionId)
    if (!session) return
    session.username = username.replace(/^@/, '')
    this.save()
  }

  remove(sessionId: string): void {
    this.config.sessions = this.config.sessions.filter((s) => s.id !== sessionId)
    this.config.columns = this.config.columns.filter((c) => c.sessionId !== sessionId)
    try {
      const dir = sessionDir(sessionId)
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
    this.save()
  }

  removeIncompleteSessions(): void {
    const incomplete = this.config.sessions.filter((s) => !s.username || !s.username.trim())
    for (const s of incomplete) {
      this.remove(s.id)
    }
  }

  addColumn(column: ColumnConfig): void {
    this.config.columns.push(column)
    this.save()
  }

  removeColumn(index: number): void {
    if (index < 0 || index >= this.config.columns.length) return
    this.config.columns.splice(index, 1)
    this.save()
  }

  moveColumn(index: number, delta: number): void {
    const target = index + delta
    const columns = this.config.columns
    if (index < 0 || index >= columns.length || target < 0 || target >= columns.length) return
    const [col] = columns.splice(index, 1)
    columns.splice(target, 0, col)
    this.save()
  }

  writeCookiesBackup(sessionId: string, cookies: unknown[]): void {
    const file = cookiesFile(sessionId)
    mkdirSync(sessionDir(sessionId), { recursive: true })
    writeFileSync(file, JSON.stringify({ cookies }, null, 2) + '\n', 'utf8')
  }

  readCookiesBackup(sessionId: string): unknown[] | null {
    const file = cookiesFile(sessionId)
    if (!existsSync(file)) return null
    try {
      const root = JSON.parse(readFileSync(file, 'utf8')) as { cookies?: unknown[] }
      return Array.isArray(root.cookies) ? root.cookies : null
    } catch {
      return null
    }
  }
}
