import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { join } from 'path'
import type { ColumnConfig, ColumnLayoutSlot, Rect } from '../../../shared/types'
import { columnUrl, DEFAULT_COLUMN_WIDTH } from '../../../shared/types'
import type { SessionStore } from '../config/store'
import { clickDesktopCreate, columnOnLoad } from '../inject/scripts'
import { exportCookiesBackup, getPartition } from '../session/partitions'
import { applyMobileViewport, useDesktopLayout } from '../session/browserIdentity'
import { attachContextMenu } from './contextMenu'

function guestPreload(): string {
  return join(__dirname, '../preload/guest.js')
}

export class ColumnManager {
  private readonly views = new Map<number, WebContentsView>()
  private readonly lastBounds = new Map<number, Electron.Rectangle>()
  private win: BrowserWindow | null = null
  private createWindow: BrowserWindow | null = null
  private createSessionId: string | null = null

  constructor(private readonly store: SessionStore) {}

  attach(win: BrowserWindow): void {
    this.win = win
  }

  async rebuild(): Promise<void> {
    this.clearViews()
    if (!this.win || this.win.isDestroyed()) return

    const config = this.store.getConfig()
    const columns = config.columns

    for (let i = 0; i < columns.length; i++) {
      const column = columns[i]
      const session = this.store.findSession(column.sessionId)
      if (!session || !session.username) continue

      const view = await this.createColumnView(column, session.username)
      this.views.set(i, view)
      this.win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    }
  }

  /**
   * Desktop Instagram's Create control opens the upload dialog.
   * The mobile site treats /create/select/ as the profile "create", so this
   * uses a desktop-sized window and a desktop user agent for that account.
   */
  openDesktopCreate(sender: WebContents): void {
    const index = this.findViewIndex(sender)
    if (index == null) return
    const column = this.store.getConfig().columns[index]
    if (!column) return
    this.showCreateWindow(column.sessionId)
  }

  private findViewIndex(sender: WebContents): number | null {
    for (const [index, view] of this.views) {
      if (view.webContents.id === sender.id) return index
    }
    return null
  }

  private showCreateWindow(sessionId: string): void {
    if (
      this.createWindow &&
      !this.createWindow.isDestroyed() &&
      this.createSessionId === sessionId
    ) {
      this.createWindow.focus()
      void this.createWindow.webContents.executeJavaScript(clickDesktopCreate()).catch(() => {})
      return
    }
    if (this.createWindow && !this.createWindow.isDestroyed()) {
      this.createWindow.close()
    }

    const ses = getPartition(sessionId)
    const win = new BrowserWindow({
      width: 1040,
      height: 840,
      minWidth: 860,
      minHeight: 640,
      title: 'Crear',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      fullscreenable: false,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.createWindow = win
    this.createSessionId = sessionId
    useDesktopLayout(win.webContents, true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    attachContextMenu(win.webContents)
    win.on('closed', () => {
      if (this.createWindow === win) {
        this.createWindow = null
        this.createSessionId = null
      }
    })
    win.webContents.on('did-finish-load', () => {
      void win.webContents.executeJavaScript(clickDesktopCreate()).catch(() => {})
    })
    void win.loadURL('https://www.instagram.com/')
  }

  reloadOne(index: number): void {
    const view = this.views.get(index)
    if (!view) return
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.reload()
      }
    } catch {
      // ignore
    }
  }

  goBack(index: number): void {
    const view = this.views.get(index)
    if (!view) return
    try {
      const contents = view.webContents
      if (contents.isDestroyed()) return
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    } catch {
      // ignore
    }
  }

  reloadAll(): void {
    Array.from(this.views.keys()).forEach((index) => this.reloadOne(index))
  }

  syncLayout(slots: ColumnLayoutSlot[]): void {
    for (const slot of slots) {
      const view = this.views.get(slot.index)
      if (!view) continue
      const next = clampRect(slot.bounds, this.win)
      const prev = this.lastBounds.get(slot.index)
      if (
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
      ) {
        continue
      }
      this.lastBounds.set(slot.index, next)
      view.setBounds(next)
      void applyMobileViewport(view.webContents, next.width, next.height)
    }
  }

  hideAll(): void {
    Array.from(this.views.entries()).forEach(([index, view]) => {
      const zero = { x: 0, y: 0, width: 0, height: 0 }
      this.lastBounds.set(index, zero)
      view.setBounds(zero)
    })
  }

  destroyCreateWindow(): void {
    const win = this.createWindow
    this.createWindow = null
    this.createSessionId = null
    if (!win || win.isDestroyed()) return
    useDesktopLayout(win.webContents, false)
    win.destroy()
  }

  async dispose(): Promise<void> {
    this.destroyCreateWindow()
    const entries = Array.from(this.views.entries())
    for (const [index, view] of entries) {
      const col = this.store.getConfig().columns[index]
      if (col) {
        try {
          await exportCookiesBackup(this.store, col.sessionId)
        } catch {
          // ignore
        }
      }
      this.destroyView(view)
    }
    this.views.clear()
    this.lastBounds.clear()
  }

  private clearViews(): void {
    Array.from(this.views.values()).forEach((view) => this.destroyView(view))
    this.views.clear()
    this.lastBounds.clear()
  }

  private destroyView(view: WebContentsView): void {
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(view)
      } catch {
        // ignore
      }
    }
    try {
      ;(view.webContents as { close?: () => void }).close?.()
    } catch {
      // ignore
    }
  }

  private async createColumnView(column: ColumnConfig, username: string): Promise<WebContentsView> {
    const ses = getPartition(column.sessionId)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: guestPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    const url = columnUrl(column.type, username, column.url)
    const script = columnOnLoad(column.type)
    let injectedOnce = false

    const inject = (force = false): void => {
      if (injectedOnce && !force) return
      injectedOnce = true
      view.webContents.executeJavaScript(script).catch(() => {})
    }

    view.webContents.on('did-finish-load', () => {
      injectedOnce = false
      inject(true)
    })
    view.webContents.on('did-navigate-in-page', () => {
      inject(false)
    })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    attachContextMenu(view.webContents)
    await applyMobileViewport(view.webContents, DEFAULT_COLUMN_WIDTH, 780)
    void view.webContents.loadURL(url)
    return view
  }
}

function clampRect(r: Rect, win: BrowserWindow | null): Electron.Rectangle {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  const width = Math.max(0, Math.round(r.width))
  const height = Math.max(0, Math.round(r.height))

  if (!win || win.isDestroyed() || width === 0 || height === 0) {
    return { x, y, width, height }
  }

  const content = win.getContentBounds()
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(content.width, x + width)
  const bottom = Math.min(content.height, y + height)
  const visW = Math.max(0, right - left)
  const visH = Math.max(0, bottom - top)

  if (visW <= 0 || visH <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  return { x, y, width, height }
}
