export interface DashTrack {
  bandwidth: number
  baseUrl: string
  initUrl: string
  segments: string[]
}

export interface DashTracks {
  video: DashTrack | null
  audio: DashTrack | null
}

export function parseDash(xml: string): DashTracks {
  const sets = xml.split(/<AdaptationSet\b/i).slice(1)
  let video: DashTrack | null = null
  let audio: DashTrack | null = null
  for (const set of sets) {
    const head = set.split(/<Representation\b/i)[0] ?? ''
    const setVideo = /contentType="video"/i.test(head) || /mimeType="video\//i.test(head)
    const setAudio = /contentType="audio"/i.test(head) || /mimeType="audio\//i.test(head)
    const setBase = firstTag(head, 'BaseURL')
    for (const rep of set.split(/<Representation\b/i).slice(1)) {
      const mime = attr(rep, 'mimeType')
      const videoRep = /video\//i.test(mime) || (setVideo && !/audio\//i.test(mime))
      const audioRep = /audio\//i.test(mime) || (setAudio && !videoRep)
      const track = trackFromRep(rep, setBase)
      if (!track) continue
      if (videoRep && (!video || track.bandwidth > video.bandwidth)) video = track
      else if (audioRep && (!audio || track.bandwidth > audio.bandwidth)) audio = track
    }
  }
  return { video, audio }
}

export function bestHlsVariant(text: string, playlistUrl: string): string | null {
  if (!text.includes('#EXT-X-STREAM-INF')) return null
  const lines = text.split(/\r?\n/)
  let bestBandwidth = -1
  let bestUrl: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('#EXT-X-STREAM-INF')) continue
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(lines[index])?.[1] ?? 0)
    const next = lines.slice(index + 1).find((line) => line.trim() && !line.trim().startsWith('#'))
    if (!next || bandwidth < bestBandwidth) continue
    bestBandwidth = bandwidth
    bestUrl = resolveMediaUrl(playlistUrl, next.trim())
  }
  return bestUrl
}

export function hlsParts(text: string, playlistUrl: string): { map: string; segments: string[] } {
  const lines = text.split(/\r?\n/)
  let map = ''
  const segments: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#EXT-X-MAP')) {
      const uri = /URI="([^"]+)"/i.exec(trimmed)?.[1]
      if (uri) map = resolveMediaUrl(playlistUrl, decodeXml(uri))
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    const url = resolveMediaUrl(playlistUrl, trimmed)
    if (url && segments.length < 400) segments.push(url)
  }
  return { map, segments }
}

export function resolveMediaUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ''
  }
}

function trackFromRep(rep: string, setBase: string): DashTrack | null {
  const bandwidth = Number(attr(rep, 'bandwidth') || 0)
  const baseUrl = firstTag(rep, 'BaseURL') || setBase
  const template = /<SegmentTemplate\b([^>]*?)\/?>/i.exec(rep)
  const initAttr = template ? attrValue(template[1], 'initialization') : ''
  const initTag = attr(/<Initialization\b[^>]*>/i.exec(rep)?.[0] ?? '', 'sourceURL')
  const segments = template ? expandTemplate(rep, template[1], baseUrl) : segmentUrls(rep, baseUrl)
  const initUrl = resolveAgainst(baseUrl, initAttr || initTag)
  const resolvedBase = resolveAgainst(baseUrl, baseUrl)
  if (!resolvedBase && !initUrl && segments.length === 0) return null
  return {
    bandwidth,
    baseUrl: resolvedBase,
    initUrl,
    segments
  }
}

function expandTemplate(rep: string, attrs: string, baseUrl: string): string[] {
  const media = attrValue(attrs, 'media')
  if (!media || !media.includes('$Number')) return []
  const start = Number(attrValue(attrs, 'startNumber') || 1)
  const id = attr(rep, 'id')
  const timeline = /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/i.exec(rep)?.[1] ?? ''
  let count = 0
  for (const mark of timeline.matchAll(/<S\b[^>]*>/gi)) {
    const repeat = Number(/r="(\d+)"/i.exec(mark[0])?.[1] ?? 0)
    count += 1 + (Number.isFinite(repeat) && repeat > 0 ? repeat : 0)
  }
  const segments: string[] = []
  for (let index = 0; index < count && index < 400; index += 1) {
    const number = String(start + index)
    const raw = media
      .split('$RepresentationID$')
      .join(id)
      .split('$Number$')
      .join(number)
      .replace(/\$Number%0(\d+)d\$/g, (_full, width: string) => number.padStart(Number(width), '0'))
    const url = resolveAgainst(baseUrl, raw)
    if (url) segments.push(url)
  }
  return segments
}

function segmentUrls(rep: string, baseUrl: string): string[] {
  const segments: string[] = []
  for (const match of rep.matchAll(/<SegmentURL\b[^>]*media="([^"]+)"/gi)) {
    const url = resolveAgainst(baseUrl, decodeXml(match[1]))
    if (url && segments.length < 400) segments.push(url)
  }
  return segments
}

function firstTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i').exec(xml)
  return match ? decodeXml(match[1]) : ''
}

function attr(xml: string, name: string): string {
  return attrValue(xml.slice(0, 800), name)
}

function attrValue(source: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(source)
  return match ? decodeXml(match[1]) : ''
}

function resolveAgainst(base: string, ref: string): string {
  if (!ref) return ''
  const absolute = ref.startsWith('https://') ? ref : base ? resolveMediaUrl(base, ref) : ''
  if (!absolute.startsWith('https://')) return ''
  try {
    const host = new URL(absolute).hostname.toLowerCase()
    if (
      host === 'cdninstagram.com' ||
      host.endsWith('.cdninstagram.com') ||
      host === 'fbcdn.net' ||
      host.endsWith('.fbcdn.net')
    ) {
      return absolute
    }
  } catch {
    return ''
  }
  return ''
}

export function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}
