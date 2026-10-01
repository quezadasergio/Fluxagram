export interface RemoteSlide {
  kind: 'image' | 'video'
  url: string
  candidates: string[]
  thumbnail: string
  dash: string
  hls: string
}

export interface FoundSlides {
  slides: RemoteSlide[]
  expected: number
}

interface ImageRef {
  url: string
  width: number
}

const NATIVE_VIDEO_KEYS = [
  'browser_native_hd_url',
  'playable_url_quality_hd',
  'browser_native_sd_url',
  'playable_url',
  'video_url'
] as const

export function slideScore(slides: RemoteSlide[]): number {
  let score = 0
  for (const slide of slides) {
    score += 10
    if (slide.kind === 'image' && slide.url) score += 5
    if (slide.kind === 'video') {
      if (slide.url || slide.candidates.length > 0) score += 5
      if (slide.dash) score += 2
      if (slide.hls) score += 2
      if (slide.thumbnail) score += 1
    }
  }
  return score
}

export function slidesFromText(text: string, code: string): FoundSlides {
  if (!code || !text.includes(code)) return { slides: [], expected: 0 }
  let best: FoundSlides = { slides: [], expected: 0 }
  for (const parsed of extractObjects(text, code)) {
    const found = slidesFromUnknown(parsed, code)
    if (slideScore(found.slides) > slideScore(best.slides)) best = found
  }
  return best
}

export function slidesFromUnknown(value: unknown, code: string): FoundSlides {
  let bestSlides: RemoteSlide[] = []
  let bestExpected = 0
  let bestScore = 0
  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 18) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const id = readCode(record)
    if (id === code) {
      const slides = slidesFromPost(record)
      const count = numberOf(record.carousel_media_count)
      const expected = count > slides.length ? count : slides.length
      const scored = slideScore(slides)
      if (scored > bestScore) {
        bestSlides = slides
        bestExpected = expected
        bestScore = scored
      }
      return
    }
    for (const entry of Object.values(record)) visit(entry, depth + 1)
  }
  visit(value, 0)
  return { slides: bestSlides, expected: bestExpected }
}

function slidesFromPost(node: Record<string, unknown>): RemoteSlide[] {
  const children = childNodes(node)
  if (children) {
    return children.map((child) => slideFromNode(child)).filter((slide): slide is RemoteSlide => slide != null)
  }
  const single = slideFromNode(node)
  return single ? [single] : []
}

function childNodes(node: Record<string, unknown>): Record<string, unknown>[] | null {
  if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) {
    const list = node.carousel_media
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry != null)
    if (list.length > 0) return list
  }
  const sidecar = asRecord(node.edge_sidecar_to_children)
  if (sidecar && Array.isArray(sidecar.edges) && sidecar.edges.length > 0) {
    const list = sidecar.edges
      .map((edge) => asRecord(asRecord(edge)?.node))
      .filter((entry): entry is Record<string, unknown> => entry != null)
    if (list.length > 0) return list
  }
  return null
}

function slideFromNode(node: Record<string, unknown>): RemoteSlide | null {
  const images = imageList(node)
  const videos = videoList(node)
  const dash = dashOf(node)
  const hls = hlsOf(node)
  const mediaType = numberOf(node.media_type)
  const video =
    mediaType === 2 || node.is_video === true || videos.length > 0 || dash.length > 0 || hls.length > 0
  if (mediaType === 1 || !video) {
    const urls = unique(images.map((image) => image.url))
    if (urls.length === 0) return null
    return {
      kind: 'image',
      url: urls[0],
      candidates: urls.slice(1, 6),
      thumbnail: pickThumb(images),
      dash: '',
      hls: ''
    }
  }
  return {
    kind: 'video',
    url: videos[0] ?? '',
    candidates: videos.slice(1, 6),
    thumbnail: pickThumb(images),
    dash,
    hls
  }
}

function imageList(node: Record<string, unknown>): ImageRef[] {
  const images: ImageRef[] = []
  const push = (value: unknown, width: unknown): void => {
    const url = cleanUrl(value)
    if (!url || !isImageUrl(url) || images.some((image) => image.url === url)) return
    images.push({ url, width: numberOf(width) })
  }
  const versions = asRecord(node.image_versions2) ?? asRecord(node.image_versions)
  if (versions && Array.isArray(versions.candidates)) {
    for (const candidate of versions.candidates) {
      const record = asRecord(candidate)
      if (record) push(record.url, record.width ?? record.original_width)
    }
  }
  if (Array.isArray(node.thumbnail_resources)) {
    for (const candidate of node.thumbnail_resources) {
      const record = asRecord(candidate)
      if (record) push(record.src, record.config_width)
    }
  }
  const dimensions = asRecord(node.dimensions)
  push(node.display_url, dimensions?.width)
  push(node.display_uri, dimensions?.width)
  push(node.thumbnail_url, 320)
  push(node.thumbnail_src, 320)
  images.sort((a, b) => (b.width || 0) - (a.width || 0))
  return images
}

function videoList(node: Record<string, unknown>): string[] {
  const urls: string[] = []
  const ranked: ImageRef[] = []
  if (Array.isArray(node.video_versions)) {
    for (const candidate of node.video_versions) {
      const record = asRecord(candidate)
      const url = cleanUrl(record?.url)
      if (!url || !isFileVideo(url) || ranked.some((item) => item.url === url)) continue
      ranked.push({ url, width: numberOf(record?.width) })
    }
  }
  ranked.sort((a, b) => (b.width || 0) - (a.width || 0))
  for (const item of ranked) urls.push(item.url)
  for (const key of NATIVE_VIDEO_KEYS) {
    const url = cleanUrl(node[key])
    if (url && isFileVideo(url) && !urls.includes(url)) urls.push(url)
  }
  return urls.slice(0, 6)
}

function dashOf(node: Record<string, unknown>): string {
  for (const key of ['video_dash_manifest', 'dash_manifest']) {
    const value = node[key]
    if (typeof value === 'string' && value.includes('<MPD') && value.includes('BaseURL')) {
      return value.slice(0, 120_000)
    }
  }
  return ''
}

function hlsOf(node: Record<string, unknown>): string {
  for (const key of ['hls_url', 'hls_playback_url', 'playback_url', 'video_url']) {
    const url = cleanUrl(node[key])
    if (url && url.includes('.m3u8')) return url
  }
  return ''
}

function pickThumb(images: ImageRef[]): string {
  const sized = images.filter((image) => image.width >= 150 && image.width <= 640)
  sized.sort((a, b) => a.width - b.width)
  if (sized[0]) return sized[0].url
  const known = images.filter((image) => image.width > 0).sort((a, b) => a.width - b.width)
  return known[0]?.url || images[images.length - 1]?.url || ''
}

function extractObjects(text: string, code: string): unknown[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return [JSON.parse(trimmed) as unknown]
    } catch {
      // The payload can be a script with JSON inside it.
    }
  }
  const decoded = text.includes(`"${code}"`) ? text : text.split('\\"').join('"').split('\\/').join('/')
  const objects: unknown[] = []
  for (const marker of [`"code":"${code}"`, `"shortcode":"${code}"`]) {
    let from = 0
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const at = decoded.indexOf(marker, from)
      if (at < 0) break
      const parsed = objectAround(decoded, at)
      if (parsed) objects.push(parsed)
      from = at + marker.length
    }
  }
  return objects
}

function objectAround(text: string, at: number): unknown | null {
  let start = text.lastIndexOf('{', at)
  for (let attempt = 0; attempt < 30 && start >= 0; attempt += 1) {
    const end = matchBrace(text, start, at)
    if (end >= at) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown
      } catch {
        // Try the parent object.
      }
    }
    if (at - start > 900_000) break
    start = text.lastIndexOf('{', start - 1)
  }
  return null
}

function matchBrace(text: string, start: number, mustCover: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  const limit = Math.min(text.length, start + 700_000)
  for (let index = start; index < limit; index += 1) {
    const char = text.charAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
    if (index > mustCover + 650_000 && depth > 40) break
  }
  return -1
}

function readCode(node: Record<string, unknown>): string {
  if (typeof node.code === 'string') return node.code
  if (typeof node.shortcode === 'string') return node.shortcode
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numberOf(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function unique(urls: string[]): string[] {
  const list: string[] = []
  for (const url of urls) {
    if (url && !list.includes(url)) list.push(url)
  }
  return list
}

export function cleanUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12) return ''
  let url = value.split('\\/').join('/').split('\\u0026').join('&').split('&amp;').join('&').replace(/\\+$/, '')
  if (url.startsWith('//')) url = `https:${url}`
  if (!url.startsWith('https://')) return ''
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (
      host !== 'cdninstagram.com' &&
      !host.endsWith('.cdninstagram.com') &&
      host !== 'fbcdn.net' &&
      !host.endsWith('.fbcdn.net')
    ) {
      return ''
    }
  } catch {
    return ''
  }
  return url
}

export function isImageUrl(url: string): boolean {
  try {
    return /\.(jpe?g|png|webp|gif|heic)$/i.test(new URL(url).pathname)
  } catch {
    return /\.(jpe?g|png|webp|gif|heic)(\?|$)/i.test(url)
  }
}

export function isAudioUrl(url: string): boolean {
  return url.includes('.m4a') || url.includes('mime_type=audio') || url.includes('mime_type%3Daudio')
}

function isFileVideo(url: string): boolean {
  return !isImageUrl(url) && !isAudioUrl(url) && !url.includes('.m3u8')
}
