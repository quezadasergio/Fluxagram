import { app, BrowserWindow, ipcMain, session, shell, webContents } from 'electron'
import { join } from 'path'
import type { ColumnConfig, ColumnLayoutSlot, Rect } from '../../shared/types'
import { isColumnType, isInstagramUrl, PARTITION_PREFIX } from '../../shared/types'
import { APP_AUTHOR, APP_AUTHOR_URL, APP_NAME, APP_VERSION } from '../../shared/version'
import { ColumnManager } from './browser/columnManager'
import { LoginManager } from './browser/loginManager'
import { SessionStore } from './config/store'
import { exportCookiesBackup } from './session/partitions'
import { applyBrowserIdentity, browserUserAgent } from './session/browserIdentity'
import type { PostMediaItem } from '../../shared/api'
import { explorePost, savePostMedia } from './media/postLink'

app.setName(APP_NAME)
app.userAgentFallback = browserUserAgent()

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
const store = new SessionStore()
const columns = new ColumnManager(store)
const login = new LoginManager(store)

function resourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources')
  }
  return join(__dirname, '../../resources')
}

function appIconPath(): string {
  return join(resourcesDir(), 'icon.png')
}

function showSplash(): BrowserWindow {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.center()
    splashWindow.show()
    return splashWindow
  }
  const splash = new BrowserWindow({
    width: 520,
    height: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  void splash.loadFile(join(resourcesDir(), 'splash.html'))
  splash.once('ready-to-show', () => {
    splash.center()
    splash.show()
  })
  splashWindow = splash
  return splash
}

function closeSplash(): void {
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null
    return
  }
  // close() on a transparent window SIGSEGVs the browser process on macOS.
  splashWindow.setFullScreenable(false)
  splashWindow.hide()
  if (process.platform !== 'darwin') {
    splashWindow.destroy()
    splashWindow = null
  }
}

/** Drop the hidden splash before the main window leaves fullscreen, so AppKit does not see a nil window. */
function retireSplash(): void {
  const splash = splashWindow
  splashWindow = null
  if (!splash || splash.isDestroyed()) return
  try {
    splash.setFullScreenable(false)
    splash.hide()
  } catch {
    // ignore
  }
  splash.destroy()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    backgroundColor: '#000000',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  columns.attach(mainWindow)
  login.attach(mainWindow, () => {
    void refreshApp()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  let mainReady = false
  let splashMinTimeDone = false

  const reveal = (): void => {
    if (!mainReady || !splashMinTimeDone) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.show()
    mainWindow.focus()
    closeSplash()
  }

  mainWindow.once('ready-to-show', () => {
    mainReady = true
    reveal()
  })

  if (splashWindow && !splashWindow.isDestroyed()) {
    const armSplashTimer = (): void => {
      setTimeout(() => {
        splashMinTimeDone = true
        reveal()
      }, 5000)
    }
    if (splashWindow.isVisible()) {
      armSplashTimer()
    } else {
      splashWindow.once('ready-to-show', armSplashTimer)
    }
  } else {
    splashMinTimeDone = true
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function refreshApp(): Promise<void> {
  store.reload()
  login.hide()
  if (store.hasLoggedInSession()) {
    await columns.rebuild()
  } else {
    await columns.dispose()
  }
  mainWindow?.webContents.send('app:state', snapshot())
}

function snapshot() {
  const config = store.getConfig()
  return {
    columnWidth: config.columnWidth,
    sessions: store.loggedInSessions(),
    columns: config.columns,
    hasLoggedIn: store.hasLoggedInSession()
  }
}

function resolveSessionIdFromSender(webContentsId: number): string | null {
  const wc = webContents.fromId(webContentsId)
  if (wc) {
    const part = (wc.session as { partition?: string }).partition || ''
    if (part.startsWith(PARTITION_PREFIX)) {
      return part.slice(PARTITION_PREFIX.length)
    }
  }
  return login.getActiveSessionId()
}

function isColumnConfig(value: unknown): value is ColumnConfig {
  if (!value || typeof value !== 'object') return false
  const column = value as ColumnConfig
  if (typeof column.type !== 'string' || !isColumnType(column.type)) return false
  if (typeof column.sessionId !== 'string' || !column.sessionId) return false
  if (column.url != null && typeof column.url !== 'string') return false
  return true
}

function registerIpc(): void {
  ipcMain.handle('app:getState', () => snapshot())

  ipcMain.handle('app:getInfo', () => ({
    name: APP_NAME,
    version: APP_VERSION,
    author: APP_AUTHOR,
    authorUrl: APP_AUTHOR_URL
  }))

  ipcMain.handle('columns:reloadAll', () => {
    columns.reloadAll()
  })

  ipcMain.handle('columns:reload', (_e, index: number) => {
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
      columns.reloadOne(index)
    }
  })

  ipcMain.handle('columns:back', (_e, index: number) => {
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
      columns.goBack(index)
    }
  })

  ipcMain.handle('post:explore', (_e, link: string) => {
    if (typeof link !== 'string') throw new Error('Pega un link de un post de instagram.com')
    return explorePost(
      link,
      store.loggedInSessions().map((s) => s.id)
    )
  })

  ipcMain.handle('post:save', (_e, item: PostMediaItem) => {
    if (!item || (item.kind !== 'image' && item.kind !== 'video')) {
      throw new Error('No se puede guardar ese archivo')
    }
    return savePostMedia(item)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('login:startFirst', async (_e, bounds: Rect) => {
    columns.hideAll()
    await login.startFirstLogin(bounds)
    return { ok: true }
  })

  ipcMain.handle('login:startAdd', async (_e, bounds: Rect) => {
    columns.hideAll()
    const id = await login.startAddAccount(bounds)
    return { sessionId: id }
  })

  ipcMain.handle('login:setBounds', (_e, bounds: Rect) => {
    login.setBounds(bounds)
  })

  ipcMain.handle('login:cancel', async () => {
    await login.cancel()
    await refreshApp()
  })

  ipcMain.handle('columns:layout', (_e, slots: ColumnLayoutSlot[]) => {
    columns.syncLayout(slots)
  })

  ipcMain.handle('columns:hide', () => {
    columns.hideAll()
  })

  ipcMain.handle('columns:rebuild', async () => {
    if (store.hasLoggedInSession()) {
      await columns.rebuild()
    }
  })

  ipcMain.handle('columns:add', async (_e, column: ColumnConfig) => {
    if (!isColumnConfig(column)) throw new Error('Columna no válida')
    const account = store.findSession(column.sessionId)
    if (!account?.username) throw new Error('Esa cuenta no tiene sesión')
    if (column.type === 'custom' && !isInstagramUrl(column.url || '')) {
      throw new Error('La URL debe ser de instagram.com')
    }
    store.addColumn({
      type: column.type,
      sessionId: column.sessionId,
      url: column.type === 'custom' ? column.url : undefined
    })
    await refreshApp()
    return snapshot()
  })

  ipcMain.handle('columns:remove', async (_e, index: number) => {
    store.removeColumn(index)
    await refreshApp()
    return snapshot()
  })

  ipcMain.handle('columns:move', async (_e, index: number, delta: number) => {
    store.moveColumn(index, delta)
    await refreshApp()
    return snapshot()
  })

  ipcMain.handle('sessions:remove', async (_e, sessionId: string) => {
    if (typeof sessionId === 'string') store.remove(sessionId)
    await refreshApp()
    return snapshot()
  })

  ipcMain.on('flux:message', (event, payload: { type: string; body: unknown }) => {
    if (payload.type === 'scrollHorizontal' && typeof payload.body === 'number') {
      mainWindow?.webContents.send('columns:wheel', payload.body)
      return
    }

    if (payload?.type === 'openCreate') {
      columns.openDesktopCreate(event.sender)
      return
    }

    const sessionId = resolveSessionIdFromSender(event.sender.id)
    if (!sessionId) return

    if (payload.type === 'userName' && typeof payload.body === 'string') {
      login.handleUserName(sessionId, payload.body)
    }
  })
}

app.whenReady().then(() => {
  applyBrowserIdentity(session.defaultSession)
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(appIconPath())
    } catch {
      // ignore
    }
  }
  showSplash()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    const hasVisibleMain = BrowserWindow.getAllWindows().some(
      (win) => win !== splashWindow && !win.isDestroyed() && win.isVisible()
    )
    if (!hasVisibleMain) {
      showSplash()
      createWindow()
    }
  })
})

let allowQuit = false

app.on('before-quit', (event) => {
  if (allowQuit) return
  event.preventDefault()
  allowQuit = true
  columns.destroyCreateWindow()
  retireSplash()
  setImmediate(() => {
    app.quit()
  })
})

app.on('window-all-closed', () => {
  closeSplash()
  columns.destroyCreateWindow()
  void columns.dispose()
  for (const s of store.loggedInSessions()) {
    exportCookiesBackup(store, s.id).catch(() => {})
  }
  if (process.platform !== 'darwin') app.quit()
})
