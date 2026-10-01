import { execFile } from 'child_process'
import { BrowserWindow, dialog, net, type Session } from 'electron'
import { createWriteStream, existsSync, unlink as unlinkFile } from 'fs'
import { copyFile, mkdtemp, open, rm, stat, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import type { PostMediaItem } from '../../../shared/api'
import { applyMobileViewport, browserUserAgent } from '../session/browserIdentity'
import { getPartition } from '../session/partitions'
import {
  cleanUrl,
  isAudioUrl,
  isImageUrl,
  type RemoteSlide
} from './instagramSlides'
import { bestHlsVariant, hlsParts, parseDash, type DashTrack } from './mediaFormats'

const MAX_BYTES = 250 * 1024 * 1024

interface RawMedia {
  url?: string
  bytes?: number
  ranged?: boolean
}

interface PageMedia {
  slides?: RemoteSlide[]
  expected?: number
  hasVideo?: boolean
  og?: string
}

type Expectation = 'image' | 'video' | 'ftyp' | 'bytes'
type FileRole = 'image' | 'video' | 'audio'

export function postUrlFromLink(input: string): string | null {
  const text = input.trim()
  const match = text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i)
  if (!match?.[1]) return null
  const kind = /instagram\.com\/(p|reel|reels|tv)\//i.exec(text)?.[1]?.toLowerCase()
  const code = match[1]
  if (kind === 'reel' || kind === 'reels') return `https://www.instagram.com/reel/${code}/`
  if (kind === 'tv') return `https://www.instagram.com/tv/${code}/`
  return `https://www.instagram.com/p/${code}/`
}

function allowed(url: string): boolean {
  const clean = cleanUrl(url)
  return clean.length > 0
}

function shortcodeOf(pageUrl: string): string {
  return /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(pageUrl)?.[1] ?? ''
}

function withoutRange(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('bytestart')
    parsed.searchParams.delete('byteend')
    return parsed.toString()
  } catch {
    return url
  }
}

function rangeSpan(url: string): number | null {
  try {
    const params = new URL(url).searchParams
    const start = Number(params.get('bytestart'))
    const end = Number(params.get('byteend'))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    return end - start
  } catch {
    return null
  }
}

function isFragmentUrl(url: string): boolean {
  return url.includes('bytestart=') || url.includes('byteend=')
}

function isProgressiveVideo(url: string): boolean {
  return allowed(url) && !isFragmentUrl(url) && !isImageUrl(url) && !isAudioUrl(url) && !url.includes('.m3u8')
}

function mediaScript(shortcode: string): string {
  return `(() => {
    const code = ${JSON.stringify(shortcode)};
    const ingest = window.__fluxIngest;
    if (typeof ingest === 'function' && code) {
      const nodes = document.scripts || [];
      for (let i = 0; i < nodes.length && i < 120; i++) {
        const text = nodes[i].textContent || '';
        if (text.indexOf(code) !== -1) ingest(text);
      }
    }
    const videos = document.querySelectorAll('video');
    for (let i = 0; i < videos.length; i++) {
      videos[i].muted = true;
      try { videos[i].play(); } catch (e) {}
    }
    const og = document.querySelector('meta[property="og:image"]');
    return {
      slides: window.__fluxSlides || [],
      expected: window.__fluxSlideExpected || 0,
      hasVideo: videos.length > 0,
      og: og && og.content ? String(og.content) : ''
    };
  })()`
}

function normalizeSlides(value: unknown): RemoteSlide[] {
  if (!Array.isArray(value)) return []
  const slides: RemoteSlide[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const slide = entry as Partial<RemoteSlide>
    if (slide.kind !== 'image' && slide.kind !== 'video') continue
    slides.push({
      kind: slide.kind,
      url: typeof slide.url === 'string' ? slide.url : '',
      candidates: Array.isArray(slide.candidates)
        ? slide.candidates.filter((url): url is string => typeof url === 'string').slice(0, 6)
        : [],
      thumbnail: typeof slide.thumbnail === 'string' ? slide.thumbnail : '',
      dash: typeof slide.dash === 'string' ? slide.dash.slice(0, 120_000) : '',
      hls: typeof slide.hls === 'string' ? slide.hls : ''
    })
  }
  return slides
}

function slideHasSource(slide: RemoteSlide): boolean {
  if (slide.kind === 'image') return allowed(slide.url)
  if ([slide.url, ...slide.candidates].some((url) => isProgressiveVideo(url) || (allowed(url) && isFragmentUrl(url)))) {
    return true
  }
  return Boolean(slide.dash.includes('<MPD') || (slide.hls && allowed(slide.hls)))
}

function toItems(slides: RemoteSlide[]): { items: PostMediaItem[]; thumbs: string[] } {
  const usable = slides.filter(slideHasSource)
  const items: PostMediaItem[] = []
  const thumbs: string[] = []
  let images = 0
  let videos = 0
  for (const slide of usable) {
    const multi = usable.length > 1
    if (slide.kind === 'video') {
      videos += 1
      const urls = uniqueUrls([slide.url, ...slide.candidates]).filter(
        (url) => !isImageUrl(url) && !isAudioUrl(url) && !url.includes('.m3u8')
      )
      items.push({
        kind: 'video',
        url: urls[0] ?? '',
        candidates: urls.slice(1),
        label: multi ? `Video ${videos}` : 'Video',
        dash: slide.dash.includes('<MPD') ? slide.dash : undefined,
        hls: slide.hls && allowed(slide.hls) ? slide.hls : undefined
      })
    } else {
      const urls = uniqueUrls([slide.url, ...slide.candidates]).filter((url) => isImageUrl(url))
      if (!urls[0]) continue
      images += 1
      items.push({
        kind: 'image',
        url: urls[0],
        candidates: urls.slice(1),
        label: multi ? `Imagen ${images}` : 'Imagen'
      })
    }
    thumbs.push(allowed(slide.thumbnail) ? slide.thumbnail : '')
  }
  return { items, thumbs }
}

function uniqueUrls(urls: string[]): string[] {
  const list: string[] = []
  for (const url of urls) {
    if (allowed(url) && !list.includes(url)) list.push(url)
  }
  return list
}

function slidesReady(page: PageMedia): boolean {
  const slides = page.slides ?? []
  if (slides.length === 0 || !slides.every(slideHasSource)) return false
  const expected = page.expected ?? slides.length
  return slides.length >= expected
}

const sessionWatchers = new WeakSet<Session>()
const mediaBuckets = new Map<number, RawMedia[]>()

function headerValue(headers: Record<string, string | string[]> | undefined, name: string): string {
  if (!headers) return ''
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase())
  if (!key) return ''
  const value = headers[key]
  return Array.isArray(value) ? value.join(' ') : String(value ?? '')
}

function watchSessionMedia(ses: Session): void {
  if (sessionWatchers.has(ses)) return
  sessionWatchers.add(ses)
  ses.webRequest.onHeadersReceived(
    { urls: ['https://*.cdninstagram.com/*', 'https://*.fbcdn.net/*'] },
    (details, callback) => {
      const bucket = details.webContentsId != null ? mediaBuckets.get(details.webContentsId) : undefined
      if (bucket && isCapturedVideo(details.url, headerValue(details.responseHeaders, 'content-type'))) {
        const length = Number(headerValue(details.responseHeaders, 'content-length'))
        const span = rangeSpan(details.url)
        bucket.push({
          url: details.url,
          ranged: span != null,
          bytes: Number.isFinite(length) && length > 0 ? length : span ?? 0
        })
      }
      callback({ responseHeaders: details.responseHeaders })
    }
  )
}

function isCapturedVideo(url: string, contentType: string): boolean {
  if (!allowed(url) || isImageUrl(url) || isAudioUrl(url) || /^image\//i.test(contentType) || /^audio\//i.test(contentType)) {
    return false
  }
  const span = rangeSpan(url)
  if (span != null && span < 50_000) return false
  return /^video\//i.test(contentType) || /\.mp4(\?|$)/i.test(url)
}

function bestCapturedVideo(captured: RawMedia[]): string | null {
  const progressive = captured.filter((item) => item.url && !item.ranged && isProgressiveVideo(item.url))
  progressive.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  if (progressive[0]?.url) return progressive[0].url
  const ranged = captured.filter((item) => item.ranged && item.url && (item.bytes ?? 0) >= 50_000)
  ranged.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  return ranged[0]?.url ?? null
}

function extractWithSession(sessionId: string, pageUrl: string): Promise<PostMediaItem[]> {
  const ses = getPartition(sessionId)
  watchSessionMedia(ses)

  const win = new BrowserWindow({
    show: false,
    width: 1040,
    height: 840,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#000000',
    webPreferences: {
      session: ses,
      preload: join(__dirname, '../preload/mediaProbe.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  const contentsId = win.webContents.id
  const captured: RawMedia[] = []
  mediaBuckets.set(contentsId, captured)
  const release = (): void => {
    if (mediaBuckets.get(contentsId) === captured) mediaBuckets.delete(contentsId)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const timeout = setTimeout(() => {
      void pull(true)
    }, 8000)

    const finish = (items: PostMediaItem[], thumbs: string[], error?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      clearTimeout(timeout)
      release()
      if (!win.isDestroyed()) win.destroy()
      if (error) {
        reject(error)
        return
      }
      void attachThumbnails(ses, items, thumbs)
        .then((ready) => resolve(ready.map((item) => ({ ...item, sessionId, shortcode: shortcodeOf(pageUrl) }))))
        .catch(() => resolve(items.map((item) => ({ ...item, sessionId, shortcode: shortcodeOf(pageUrl) }))))
    }

    const wantVideo = /\/(?:reel|reels|tv)\//i.test(pageUrl)
    let loadedAt = 0
    const pull = async (force: boolean): Promise<void> => {
      if (settled || win.isDestroyed()) return
      if (!loadedAt && !force) return
      let page: PageMedia = {}
      try {
        page = (await win.webContents.executeJavaScript(mediaScript(shortcodeOf(pageUrl)))) as PageMedia
      } catch {
        page = {}
      }
      page.slides = normalizeSlides(page.slides)
      const waited = loadedAt > 0 && Date.now() - loadedAt > 1500
      if (slidesReady(page) && ((page.slides?.length ?? 0) > 1 || waited)) {
        const built = toItems(page.slides ?? [])
        if (built.items.length > 0) {
          finish(built.items, built.thumbs)
          return
        }
      }
      if (!force) return
      if ((page.slides?.length ?? 0) > 0) {
        const built = toItems(page.slides ?? [])
        if (built.items.length > 0) {
          finish(built.items, built.thumbs)
          return
        }
      }
      const videoPage = wantVideo || Boolean(page.hasVideo)
      const capturedUrl = bestCapturedVideo(captured)
      if (capturedUrl && videoPage) {
        const thumb = page.og && isImageUrl(page.og) && allowed(page.og) ? page.og : ''
        finish([{ kind: 'video', url: capturedUrl, label: 'Video' }], [thumb])
        return
      }
      if (!videoPage && page.og && isImageUrl(page.og) && allowed(page.og)) {
        finish([{ kind: 'image', url: page.og, label: 'Imagen' }], [page.og])
        return
      }
      finish([], [])
    }

    timer = setInterval(() => {
      void pull(false)
    }, 700)

    win.webContents.setAudioMuted(true)
    win.webContents.setBackgroundThrottling(false)
    win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) captured.length = 0
    })
    const markLoaded = (): void => {
      if (!loadedAt) loadedAt = Date.now()
      void pull(false)
    }
    win.webContents.on('dom-ready', markLoaded)
    win.webContents.on('did-finish-load', markLoaded)
    win.webContents.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code < 0 && code !== -3) finish([], [], new Error('No se pudo abrir el post'))
    })

    try {
      applyMobileViewport(win.webContents, 1040, 840)
      void win.webContents.loadURL(pageUrl)
    } catch (error) {
      finish([], [], error instanceof Error ? error : new Error('No se pudo abrir el post'))
    }
  })
}

async function attachThumbnails(ses: Session, items: PostMediaItem[], thumbs: string[]): Promise<PostMediaItem[]> {
  const downloader = new MediaDownloader(ses)
  const images = await Promise.all(
    thumbs.map(async (url) => {
      if (!url || !isImageUrl(url)) return ''
      try {
        const buffer = await downloader.fetchBuffer(url, 350_000, 6000)
        return imageDataUrl(buffer) ?? ''
      } catch {
        return ''
      }
    })
  )
  return items.map((item, index) => (images[index] ? { ...item, thumbnail: images[index] } : item))
}

function imageDataUrl(buffer: Buffer): string | null {
  const kind = pictureType(buffer)
  if (!kind) return null
  const mime = kind === 'jpg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : kind === 'webp' ? 'image/webp' : 'image/gif'
  return `data:${mime};base64,${buffer.toString('base64')}`
}

export async function explorePost(link: string, sessionIds: string[]): Promise<PostMediaItem[]> {
  const pageUrl = postUrlFromLink(link)
  if (!pageUrl) throw new Error('Pega un link de un post o reel de instagram.com')
  if (sessionIds.length === 0) throw new Error('Inicia sesión para explorar un post')

  let lastError: Error | null = null
  for (const sessionId of sessionIds) {
    try {
      const items = await extractWithSession(sessionId, pageUrl)
      if (items.length > 0) return items
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('No se pudo leer el post')
    }
  }
  if (lastError) throw lastError
  throw new Error('Este post no tiene imágenes ni videos')
}

function extensionFor(url: string, kind: 'image' | 'video'): string {
  if (kind === 'video') return 'mp4'
  try {
    const ext = basename(new URL(url).pathname).split('.').pop()?.toLowerCase()
    if (ext && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
  } catch {
    // The image link has no usable extension.
  }
  return 'jpg'
}

function mediaFileName(item: PostMediaItem, ext: string): string {
  const kind = item.kind === 'video' ? 'video' : 'image'
  const match = /(\d+)\s*$/.exec(item.label)
  const index = match ? Number(match[1]) : 1
  const code = (item.shortcode ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  const stem = code ? `${code}-${kind}-${index}` : `${kind}-${index}`
  return `${stem}.${ext}`
}

function hasDownloadSource(item: PostMediaItem): boolean {
  if (uniqueUrls([item.url, ...(item.candidates ?? [])]).length > 0) return true
  if (item.kind === 'video' && typeof item.dash === 'string' && item.dash.includes('<MPD')) return true
  return item.kind === 'video' && typeof item.hls === 'string' && allowed(item.hls)
}

export async function savePostMedia(item: PostMediaItem): Promise<boolean> {
  if (!item.sessionId) throw new Error('Inicia sesión para guardar el archivo')
  if (!hasDownloadSource(item)) throw new Error('Ese archivo no se puede guardar')
  const ext = extensionFor(item.url, item.kind)
  const result = await dialog.showSaveDialog({
    title: `Guardar ${item.label}`,
    defaultPath: mediaFileName(item, ext),
    buttonLabel: 'Guardar',
    filters:
      item.kind === 'video'
        ? [{ name: 'Video', extensions: ['mp4'] }]
        : [{ name: 'Imagen', extensions: [ext, 'jpg', 'png', 'webp', 'gif'] }]
  })
  if (result.canceled || !result.filePath) return false
  await new MediaDownloader(getPartition(item.sessionId)).save(item, result.filePath)
  return true
}

class MediaDownloader {
  constructor(private readonly ses: Session) {}

  async save(item: PostMediaItem, filePath: string): Promise<void> {
    if (item.kind === 'image') {
      await this.saveImage(item, filePath)
      return
    }
    await this.saveVideo(item, filePath)
  }

  fetchBuffer(url: string, maxBytes: number, timeoutMs = 15000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const request = net.request({
        url,
        session: this.ses,
        useSessionCookies: true,
        redirect: 'follow'
      })
      this.decorate(request)
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      const timer = setTimeout(() => {
        request.abort()
        fail(new Error('No se pudo descargar'))
      }, timeoutMs)
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      request.on('response', (response) => {
        const status = response.statusCode ?? 0
        const type = headerValue(response.headers, 'content-type')
        if (status >= 400 || /text\/html/i.test(type)) {
          response.on('data', () => undefined)
          fail(new Error(status >= 400 ? `No se pudo descargar (${status})` : 'Instagram no entregó el archivo'))
          return
        }
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBytes) {
            request.abort()
            fail(new Error('El archivo supera el tamaño esperado'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(Buffer.concat(chunks))
        })
        response.on('error', (error) => fail(error instanceof Error ? error : new Error('No se pudo descargar')))
      })
      request.on('error', (error) => fail(error instanceof Error ? error : new Error('No se pudo descargar')))
      request.end()
    })
  }

  private async saveImage(item: PostMediaItem, filePath: string): Promise<void> {
    const urls = uniqueUrls([item.url, ...(item.candidates ?? [])]).filter((url) => isImageUrl(url))
    let last: Error | null = null
    for (const url of urls) {
      try {
        await this.tryWholeFile(url, filePath, 'image')
        return
      } catch (error) {
        last = preferError(last, error)
      }
    }
    throw polish(last, 'image')
  }

  private async saveVideo(item: PostMediaItem, filePath: string): Promise<void> {
    const urls = uniqueUrls([item.url, ...(item.candidates ?? [])]).filter(
      (url) => !isImageUrl(url) && !isAudioUrl(url) && !url.includes('.m3u8')
    )
    let last: Error | null = null
    for (const url of urls) {
      try {
        await this.tryWholeFile(url, filePath, 'video')
        return
      } catch (error) {
        last = preferError(last, error)
      }
    }
    if (item.dash?.includes('<MPD')) {
      try {
        await this.downloadDash(item.dash, filePath)
        return
      } catch (error) {
        last = preferError(last, error)
      }
    }
    if (item.hls && allowed(item.hls)) {
      try {
        await this.downloadHls(item.hls, filePath)
        return
      } catch (error) {
        last = preferError(last, error)
      }
    }
    throw polish(last, 'video')
  }

  private async tryWholeFile(url: string, filePath: string, role: FileRole): Promise<void> {
    if (!allowed(url)) throw new Error('Ese archivo no se puede guardar')
    const span = rangeSpan(url)
    const minimum = role === 'image' ? 1024 : role === 'audio' ? 64 : 20_000
    const attempts: Array<{ url: string; range?: string }> = []
    if (span != null && span >= minimum) attempts.push({ url })
    const plain = withoutRange(url)
    if (!attempts.some((attempt) => attempt.url === plain && !attempt.range)) attempts.push({ url: plain })
    if (role === 'video') attempts.push({ url: plain, range: 'bytes=0-' })
    let last: Error | null = null
    for (const attempt of attempts) {
      try {
        await this.downloadFile(attempt.url, filePath, role === 'image' ? 'image' : role === 'audio' ? 'ftyp' : 'video', attempt.range)
        return
      } catch (error) {
        last = preferError(last, error)
      }
    }
    throw last ?? new Error('No se pudo descargar')
  }

  private async downloadDash(xml: string, filePath: string): Promise<void> {
    const tracks = parseDash(xml)
    if (!tracks.video) throw new Error('El manifiesto no trae el video')
    const dir = await mkdtemp(join(tmpdir(), 'fluxagram-'))
    const videoPath = join(dir, 'video.mp4')
    const audioPath = join(dir, 'audio.m4a')
    try {
      await this.materialize(tracks.video, videoPath, 'video')
      if (!(await fileLooksLikeVideo(videoPath))) throw new Error('El archivo no es un video reproducible')
      let merged = false
      if (tracks.audio && !(await fileContainsAudio(videoPath))) {
        const bin = await findFfmpeg()
        if (!bin) throw new Error('Este video trae el audio aparte. Instala ffmpeg para unirlo.')
        await this.materialize(tracks.audio, audioPath, 'audio')
        await this.mux(videoPath, audioPath, filePath)
        merged = true
      }
      if (!merged) await copyFile(videoPath, filePath)
      if (!(await fileLooksLikeVideo(filePath))) {
        await unlink(filePath).catch(() => undefined)
        throw new Error('El archivo no es un video reproducible')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async downloadHls(playlistUrl: string, filePath: string): Promise<void> {
    if (!allowed(playlistUrl)) throw new Error('La lista del video no se puede leer')
    let url = playlistUrl
    let text = (await this.fetchBuffer(url, 1_000_000)).toString('utf8')
    for (let hop = 0; hop < 3 && text.includes('#EXT-X-STREAM-INF'); hop += 1) {
      const next = bestHlsVariant(text, url)
      if (!next || next === url || !allowed(next)) break
      url = next
      text = (await this.fetchBuffer(url, 1_000_000)).toString('utf8')
    }
    const parts = hlsParts(text, url)
    if (parts.segments.length === 0) throw new Error('La lista del video no trae partes')
    const dir = await mkdtemp(join(tmpdir(), 'fluxagram-'))
    try {
      const names: PlaylistPart[] = []
      if (parts.map && allowed(parts.map)) {
        await this.downloadFile(parts.map, join(dir, 'init.mp4'), 'bytes')
        names.push({ file: 'init.mp4', map: true })
      }
      for (let index = 0; index < parts.segments.length; index += 1) {
        const file = `seg${index}.bin`
        await this.downloadFile(parts.segments[index], join(dir, file), 'bytes')
        names.push({ file, map: false })
      }
      await this.fuse(dir, names, filePath)
      if (!(await fileLooksLikeVideo(filePath))) {
        await unlink(filePath).catch(() => undefined)
        throw new Error('El archivo no es un video reproducible')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async materialize(track: DashTrack, dest: string, role: FileRole): Promise<void> {
    if (track.baseUrl) {
      try {
        await this.tryWholeFile(track.baseUrl, dest, role)
        return
      } catch {
        // The track can still be stored as separate parts.
      }
    }
    const parts = [track.initUrl, ...track.segments].filter((url) => url && allowed(url))
    if (parts.length === 0) throw new Error('El manifiesto no trae el video')
    const dir = await mkdtemp(join(tmpdir(), 'fluxagram-'))
    try {
      const names: PlaylistPart[] = []
      for (let index = 0; index < parts.length; index += 1) {
        const file = `part${index}.mp4`
        await this.downloadFile(parts[index], join(dir, file), 'bytes')
        names.push({ file, map: index === 0 && Boolean(track.initUrl) })
      }
      await this.fuse(dir, names, dest)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async fuse(dir: string, names: PlaylistPart[], dest: string): Promise<void> {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD']
    for (const part of names) {
      if (part.map) lines.push(`#EXT-X-MAP:URI="${part.file}"`)
      else {
        lines.push('#EXTINF:2,')
        lines.push(part.file)
      }
    }
    lines.push('#EXT-X-ENDLIST')
    await writeFile(join(dir, 'index.m3u8'), lines.join('\n'))
    const input = join(dir, 'index.m3u8')
    try {
      try {
        await this.ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-allowed_extensions', 'ALL', '-i', input, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', dest])
      } catch (error) {
        if (isFfmpegMissing(error)) throw error
        await this.ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-allowed_extensions', 'ALL', '-i', input, '-c', 'copy', '-movflags', '+faststart', dest])
      }
    } catch (error) {
      await unlink(dest).catch(() => undefined)
      throw mergeError(error)
    }
  }

  private async mux(videoPath: string, audioPath: string, dest: string): Promise<void> {
    try {
      await this.ffmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        videoPath,
        '-i',
        audioPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-shortest',
        dest
      ])
    } catch (error) {
      await unlink(dest).catch(() => undefined)
      throw mergeError(error)
    }
  }

  private async ffmpeg(args: string[]): Promise<void> {
    const bin = await findFfmpeg()
    if (!bin) throw new Error('Este video viene en partes. Instala ffmpeg para unirlo en un solo archivo.')
    await runFfmpeg(bin, args)
  }

  private decorate(request: { setHeader: (name: string, value: string) => void }): void {
    request.setHeader('Referer', 'https://www.instagram.com/')
    request.setHeader('Origin', 'https://www.instagram.com')
    request.setHeader('User-Agent', browserUserAgent())
    request.setHeader('Accept', '*/*')
  }

  private downloadFile(url: string, filePath: string, expect: Expectation, range?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!allowed(url)) {
        reject(new Error('Ese archivo no se puede guardar'))
        return
      }
      const request = net.request({
        url,
        session: this.ses,
        useSessionCookies: true,
        redirect: 'follow'
      })
      this.decorate(request)
      if (range) request.setHeader('Range', range)
      let total = 0
      let header = Buffer.alloc(0)
      request.on('response', (response) => {
        const status = response.statusCode ?? 0
        const type = headerValue(response.headers, 'content-type')
        if (status >= 400 || /text\/html/i.test(type)) {
          response.on('data', () => undefined)
          reject(new Error(status >= 400 ? `No se pudo descargar (${status})` : 'Instagram no entregó el archivo'))
          return
        }
        let failed = false
        const file = createWriteStream(filePath)
        const fail = (error: Error): void => {
          if (failed) return
          failed = true
          file.destroy()
          unlinkFile(filePath, () => reject(error))
        }
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (header.length < 16) header = Buffer.concat([header, chunk]).subarray(0, 16)
          if (total > MAX_BYTES) {
            request.abort()
            fail(new Error('El archivo supera 250 MB'))
            return
          }
          file.write(chunk)
        })
        response.on('end', () => {
          if (failed) return
          file.end(() => {
            if (!matches(expect, header, total)) {
              unlinkFile(filePath, () =>
                reject(
                  new Error(
                    expect === 'video' && pictureType(header)
                      ? 'Eso es la miniatura del video, no el video'
                      : expect === 'image'
                        ? 'El archivo no es una imagen'
                        : 'El archivo no es un video reproducible'
                  )
                )
              )
              return
            }
            resolve()
          })
        })
        response.on('error', (error) => fail(error instanceof Error ? error : new Error('No se pudo descargar')))
      })
      request.on('error', reject)
      request.end()
    })
  }
}

interface PlaylistPart {
  file: string
  map: boolean
}

function matches(expect: Expectation, header: Buffer, total: number): boolean {
  const picture = pictureType(header)
  const ftyp = header.includes(Buffer.from('ftyp'))
  if (expect === 'image') return total >= 1024 && picture != null
  if (expect === 'video') return total >= 20_000 && ftyp && !picture
  if (expect === 'ftyp') return total >= 64 && ftyp && !picture
  return total >= 32
}

function pictureType(header: Buffer): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (header[0] === 0xff && header[1] === 0xd8) return 'jpg'
  if (header.subarray(0, 4).toString('ascii') === '\x89PNG') return 'png'
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (header.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  return null
}

function preferError(current: Error | null, error: unknown): Error {
  const next = error instanceof Error ? error : new Error('No se pudo descargar')
  if (!current) return next
  return rank(next.message) >= rank(current.message) ? next : current
}

function rank(message: string): number {
  if (message.includes('ffmpeg') || message.includes('aparte') || message.includes('partes')) return 5
  if (message.includes('No se pudo descargar (')) return 4
  if (message.includes('250 MB')) return 4
  if (message.includes('miniatura')) return 3
  return 1
}

function polish(error: Error | null, kind: 'image' | 'video'): Error {
  if (error && rank(error.message) >= 3) return error
  return new Error(kind === 'video' ? 'No se pudo armar el video' : 'No se pudo guardar la imagen')
}

let ffmpegBin: string | null | undefined

async function findFfmpeg(): Promise<string | null> {
  if (ffmpegBin !== undefined) return ffmpegBin
  const candidates =
    process.platform === 'win32'
      ? ['ffmpeg.exe', 'ffmpeg']
      : process.platform === 'darwin'
        ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
        : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']
  for (const bin of candidates) {
    if (bin.includes('/') && !existsSync(bin)) continue
    try {
      await runFfmpeg(bin, ['-version'])
      ffmpegBin = bin
      return bin
    } catch {
      // Try the next location.
    }
  }
  ffmpegBin = null
  return null
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function fileLooksLikeVideo(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath)
    if (info.size < 20_000) return false
    const fh = await open(filePath, 'r')
    try {
      const head = Buffer.alloc(16)
      await fh.read(head, 0, 16, 0)
      return !pictureType(head) && head.includes(Buffer.from('ftyp'))
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

function isFfmpegMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Este video')
}

function mergeError(error: unknown): Error {
  if (isFfmpegMissing(error)) return error as Error
  return new Error('No se pudo unir las partes del video')
}

async function fileContainsAudio(filePath: string): Promise<boolean> {
  const info = await stat(filePath)
  const fh = await open(filePath, 'r')
  try {
    const take = Math.min(info.size, 2 * 1024 * 1024)
    const head = Buffer.alloc(take)
    await fh.read(head, 0, take, 0)
    if (head.includes(Buffer.from('soun')) || head.includes(Buffer.from('mp4a'))) return true
    if (info.size > take) {
      const tail = Buffer.alloc(take)
      await fh.read(tail, 0, take, info.size - take)
      if (tail.includes(Buffer.from('soun')) || tail.includes(Buffer.from('mp4a'))) return true
    }
    return false
  } finally {
    await fh.close()
  }
}
