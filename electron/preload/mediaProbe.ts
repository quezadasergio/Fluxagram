import { slidesFromText, slidesFromUnknown, slideScore, type RemoteSlide } from '../main/media/instagramSlides'

export {}

declare global {
  interface Window {
    __fluxSlides: RemoteSlide[]
    __fluxSlideExpected: number
    __fluxIngest: (text: string) => void
  }
}

const seen = new Set<string>()

function currentCode(): string {
  return /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(location.pathname)?.[1] ?? ''
}

function accept(slides: RemoteSlide[], expected: number): void {
  if (slides.length === 0) return
  const current = window.__fluxSlides || []
  if (slideScore(slides) <= slideScore(current)) return
  window.__fluxSlides = slides
  window.__fluxSlideExpected = expected > 0 ? expected : slides.length
}

function ingestText(text: string): void {
  const code = currentCode()
  if (!code || !text || text.length > 6_000_000 || !text.includes(code)) return
  const mark = `${text.length}:${text.indexOf(code)}`
  if (seen.has(mark)) return
  seen.add(mark)
  const found = slidesFromText(text, code)
  accept(found.slides, found.expected)
}

function ingestValue(value: unknown): void {
  const code = currentCode()
  if (!code || !value) return
  const found = slidesFromUnknown(value, code)
  accept(found.slides, found.expected)
}

window.__fluxSlides = []
window.__fluxSlideExpected = 0
window.__fluxIngest = ingestText

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function skipBody(url: string): boolean {
  return /\.(mp4|m4s|m4a|jpe?g|png|webp|gif|heic)(\?|$)/i.test(url)
}

const originalFetch = window.fetch.bind(window)
window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const response = await originalFetch(...args)
  try {
    const url = requestUrl(args[0])
    if (skipBody(url)) return response
    const type = response.headers.get('content-type') || ''
    if (!type || /json|javascript|text|xml/i.test(type)) ingestText(await response.clone().text())
  } catch {
    // The page keeps the original response.
  }
  return response
}

const xhrOpen = XMLHttpRequest.prototype.open
const xhrSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null
): void {
  return xhrOpen.call(this, method, url, async ?? true, username, password)
}
XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
  this.addEventListener('load', () => {
    try {
      const responseType = this.responseType
      if (responseType === 'json') {
        ingestValue(this.response)
        return
      }
      if (responseType && responseType !== 'text') return
      ingestText(this.responseText)
    } catch {
      // Ignore responses that are not the post payload.
    }
  })
  return xhrSend.call(this, body)
}
