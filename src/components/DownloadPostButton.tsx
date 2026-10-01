import { useEffect, useRef, useState } from 'react'
import type { PostMediaItem } from '@shared/api'

const api = window.fluxagramApi

function plainError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : fallback
  const wrapped = raw.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]+)/)
  return wrapped?.[1]?.trim() || raw
}

interface Props {
  onOpenChange: (open: boolean) => void
}

export function DownloadPostButton({ onOpenChange }: Props) {
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const [items, setItems] = useState<PostMediaItem[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)

  const close = (): void => {
    requestRef.current += 1
    setOpen(false)
    setLink('')
    setItems([])
    setError(null)
    setBusy(false)
    setSaving(null)
  }

  useEffect(() => {
    onOpenChange(open)
  }, [open, onOpenChange])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    const onPointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [open])

  const explore = (): void => {
    const request = ++requestRef.current
    setBusy(true)
    setError(null)
    setItems([])
    void api
      .explorePost(link)
      .then((next) => {
        if (request !== requestRef.current) return
        setItems(next)
      })
      .catch((err: unknown) => {
        if (request !== requestRef.current) return
        setError(plainError(err, 'No se pudo explorar el post'))
      })
      .finally(() => {
        if (request === requestRef.current) setBusy(false)
      })
  }

  return (
    <div className="download-anchor" ref={rootRef}>
      <button
        className="icon-btn"
        type="button"
        title="Descargar medios de un post"
        aria-label="Descargar medios de un post"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        <span className="icon-refresh" aria-hidden="true">
          ↓
        </span>
      </button>
      {open && (
        <div className="download-panel" role="dialog" aria-label="Explorar post">
          <button
            className="icon-btn download-close"
            type="button"
            title="Cerrar"
            aria-label="Cerrar"
            onClick={close}
          >
            ✕
          </button>
          <p className="download-help">
            Coloca el link de un post o reel. Si tiene varias fotos o videos, cada uno aparece con su miniatura.
          </p>
          <div className="download-row">
            <span className="download-label">Link:</span>
            <input
              type="url"
              placeholder="https://www.instagram.com/p/…"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') explore()
              }}
            />
            <button className="btn" type="button" disabled={busy || link.trim().length === 0} onClick={explore}>
              {busy ? '…' : 'Explorar'}
            </button>
          </div>
          <p className="download-hint">Presiona el botón del contenido multimedia que quieras descargar</p>
          {error && <p className="download-error">{error}</p>}
          {items.length > 0 && (
            <div className="download-files">
              {items.map((item, index) => (
                <div className="download-card" key={`${item.kind}-${index}`}>
                  <div className="download-thumb-wrap">
                    {item.thumbnail ? (
                      <img className="download-thumb" src={item.thumbnail} alt="" />
                    ) : (
                      <div className="download-thumb download-thumb-empty" />
                    )}
                    {item.kind === 'video' && (
                      <span className="download-play" aria-hidden="true">
                        ▶
                      </span>
                    )}
                  </div>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={saving !== null}
                    onClick={() => {
                      const request = requestRef.current
                      setSaving(index)
                      setError(null)
                      void api
                        .savePostMedia({
                          kind: item.kind,
                          url: item.url,
                          label: item.label,
                          sessionId: item.sessionId,
                          candidates: item.candidates,
                          dash: item.dash,
                          hls: item.hls,
                          shortcode: item.shortcode
                        })
                        .catch((err: unknown) => {
                          if (request !== requestRef.current) return
                          setError(plainError(err, 'No se pudo guardar'))
                        })
                        .finally(() => {
                          if (request === requestRef.current) setSaving(null)
                        })
                    }}
                  >
                    {saving === index ? 'Guardando…' : item.label}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
