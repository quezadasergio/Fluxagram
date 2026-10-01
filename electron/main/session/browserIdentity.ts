import { app, type Session, type WebContents } from 'electron'

const patchedSessions = new WeakSet<Session>()
/** Tracks the separate Crear window. Columns use the same desktop identity. */
let createContentsId: number | null = null

function chromeMajorFromFallback(): string {
  return app.userAgentFallback.match(/Chrome\/(\d+)/)?.[1] ?? '132'
}

/** Desktop Chrome identity so Instagram serves the web app with the left sidebar. */
export function desktopUserAgent(): string {
  const chrome = chromeMajorFromFallback()
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`
  }
  if (process.platform === 'linux') {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`
  }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`
}

/** Default identity for columns, login, and media requests. */
export function browserUserAgent(): string {
  return desktopUserAgent()
}

function desktopPlatform(): string {
  if (process.platform === 'win32') return '"Windows"'
  if (process.platform === 'linux') return '"Linux"'
  return '"macOS"'
}

export function useDesktopLayout(webContents: WebContents, enabled: boolean): void {
  if (enabled) {
    if (webContents.isDestroyed()) return
    createContentsId = webContents.id
    webContents.setUserAgent(desktopUserAgent())
    webContents.once('destroyed', () => {
      if (createContentsId === webContents.id) createContentsId = null
    })
    return
  }
  if (!webContents.isDestroyed() && createContentsId === webContents.id) {
    webContents.setUserAgent(desktopUserAgent())
  }
  if (webContents.isDestroyed() || createContentsId === webContents.id) {
    createContentsId = null
  }
}

function setHeader(headers: Record<string, string | string[]>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
  if (existing) headers[existing] = value
  else headers[name] = value
}

export function applyBrowserIdentity(ses: Session): void {
  if (patchedSessions.has(ses)) return
  patchedSessions.add(ses)

  const ua = desktopUserAgent()
  ses.setUserAgent(ua)
  const major = chromeMajorFromFallback()

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    setHeader(headers, 'User-Agent', ua)
    setHeader(headers, 'sec-ch-ua-mobile', '?0')
    setHeader(headers, 'sec-ch-ua-platform', desktopPlatform())
    for (const key of Object.keys(headers)) {
      if (!key.toLowerCase().startsWith('sec-ch-ua')) continue
      if (key.toLowerCase() === 'sec-ch-ua-mobile' || key.toLowerCase() === 'sec-ch-ua-platform') continue
      const value = headers[key]
      if (typeof value !== 'string') continue
      headers[key] = value.replace(/"Electron";v="[^"]*"/g, `"Google Chrome";v="${major}"`)
    }
    callback({ requestHeaders: headers })
  })
}

/**
 * Instagram decides desktop vs phone from the user agent. Attaching the Chrome
 * debugger to emulate a device crashes the browser process on macOS (SIGSEGV
 * a few seconds after the main window opens), so identity is applied without it.
 */
export function installPageIdentity(webContents: WebContents): void {
  if (webContents.isDestroyed()) return
  webContents.setUserAgent(desktopUserAgent())
}

export function applyMobileViewport(webContents: WebContents, width: number, height: number): void {
  if (webContents.isDestroyed()) return
  if (width < 50 || height < 50) return
  installPageIdentity(webContents)
}
