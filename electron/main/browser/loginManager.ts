import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import type { Rect } from '../../../shared/types'
import { LOGIN_URL } from '../../../shared/types'
import type { SessionStore } from '../config/store'
import { detectUserNameOnce, loginOnLoad } from '../inject/scripts'
import { exportCookiesBackup, getPartition } from '../session/partitions'
import { applyMobileViewport } from '../session/browserIdentity'
import { attachContextMenu } from './contextMenu'

function guestPreload(): string {
  return join(__dirname, '../preload/guest.js')
}

export class LoginManager {
  private view: WebContentsView | null = null
  private sessionId: string | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private win: BrowserWindow | null = null
  private onLoggedIn: (() => void) | null = null

  constructor(private readonly store: SessionStore) {}

  attach(win: BrowserWindow, onLoggedIn: () => void): void {
    this.win = win
    this.onLoggedIn = onLoggedIn
  }

  async startFirstLogin(bounds: Rect): Promise<void> {
    await this.stop(false)
    this.store.removeIncompleteSessions()
    const record = this.store.createNew()
    this.sessionId = record.id
    await this.mountLoginView(record.id, bounds)
  }

  async startAddAccount(bounds: Rect): Promise<string> {
    await this.stop(false)
    const record = this.store.createNew()
    this.sessionId = record.id
    await this.mountLoginView(record.id, bounds)
    return record.id
  }

  setBounds(bounds: Rect): void {
    const next = this.place(bounds)
    if (!next || !this.view) return
    void applyMobileViewport(this.view.webContents, next.width, next.height)
  }

  hide(): void {
    if (this.view) {
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }

  async cancel(): Promise<void> {
    await this.stop(true)
  }

  handleUserName(sessionId: string, username: string): void {
    const id = this.sessionId ?? sessionId
    if (!id) return
    const clean = String(username).replace(/^@/, '').trim()
    if (!clean) return

    const existing = this.store.findSession(id)
    const previous = existing?.username?.trim() ?? ''
    if (previous.toLowerCase() === clean.toLowerCase()) {
      return
    }

    const completingLogin = !previous || this.sessionId === id
    this.store.setUsername(id, clean)
    if (this.view) {
      exportCookiesBackup(this.store, id).catch(() => {})
    }
    console.log(`Fluxagram: usuario detectado @${clean}`)

    if (!completingLogin) return

    void this.stop(false)
    this.onLoggedIn?.()
  }

  getActiveSessionId(): string | null {
    return this.sessionId
  }

  private place(bounds: Rect): { width: number; height: number } | null {
    if (!this.view) return null
    const next = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    this.view.setBounds(next)
    return next
  }

  private async mountLoginView(sessionId: string, bounds: Rect): Promise<void> {
    if (!this.win || this.win.isDestroyed()) return

    const ses = getPartition(sessionId)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: guestPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.view = view
    this.win.contentView.addChildView(view)
    const placed = this.place(bounds)

    const inject = (): void => {
      view.webContents.executeJavaScript(loginOnLoad()).catch(() => {})
    }

    view.webContents.on('did-finish-load', inject)
    view.webContents.on('did-navigate-in-page', inject)
    view.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
    attachContextMenu(view.webContents)
    await applyMobileViewport(
      view.webContents,
      placed?.width ?? bounds.width,
      placed?.height ?? bounds.height
    )
    void view.webContents.loadURL(LOGIN_URL)

    let ticks = 0
    this.probeTimer = setInterval(() => {
      if (!this.view || this.view.webContents.isDestroyed()) return
      this.view.webContents.executeJavaScript(detectUserNameOnce()).catch(() => {})
      if (++ticks > 90) {
        if (this.probeTimer) clearInterval(this.probeTimer)
        this.probeTimer = null
      }
    }, 1500)
  }

  private async stop(removeIncomplete: boolean): Promise<void> {
    if (this.probeTimer) {
      clearInterval(this.probeTimer)
      this.probeTimer = null
    }
    const id = this.sessionId
    if (this.view) {
      if (this.win && !this.win.isDestroyed()) {
        try {
          this.win.contentView.removeChildView(this.view)
        } catch {
          // ignore
        }
      }
      try {
        this.view.webContents.close()
      } catch {
        // ignore
      }
      this.view = null
    }
    this.sessionId = null
    if (removeIncomplete && id) {
      const session = this.store.findSession(id)
      if (session && (!session.username || !session.username.trim())) {
        this.store.remove(id)
      }
    }
  }
}
