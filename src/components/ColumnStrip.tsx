import { useEffect, useRef } from 'react'
import type { ColumnConfig, SessionRecord } from '@shared/types'
import { COLUMN_TYPE_LABELS } from '@shared/types'

const api = window.fluxagramApi

interface Props {
  columns: ColumnConfig[]
  sessions: SessionRecord[]
  columnWidth: number
  /** When true, native WebContentsViews are hidden so HTML modals are clickable. */
  viewsSuspended?: boolean
  onMove: (index: number, delta: number) => void | Promise<void>
  onClose: (index: number) => void | Promise<void>
  onReload: (index: number) => void | Promise<void>
  onBack: (index: number) => void | Promise<void>
}

export function ColumnStrip({
  columns,
  sessions,
  columnWidth,
  viewsSuspended = false,
  onMove,
  onClose,
  onReload,
  onBack
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null)
  const bodyRefs = useRef<(HTMLDivElement | null)[]>([])
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    bodyRefs.current = bodyRefs.current.slice(0, columns.length)
  }, [columns.length])

  useEffect(() => {
    return api.onColumnWheel((deltaX) => {
      const strip = stripRef.current
      if (!strip) return
      strip.scrollLeft += deltaX
    })
  }, [])

  useEffect(() => {
    if (viewsSuspended) return
    void api.rebuildColumns().then(() => {
      stripRef.current?.dispatchEvent(new Event('scroll'))
    })
  }, [columns, columnWidth])

  useEffect(() => {
    if (viewsSuspended) {
      void api.hideColumns()
      return
    }

    const report = (): void => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const slots = columns.map((_, index) => {
          const el = bodyRefs.current[index]
          const r = el?.getBoundingClientRect()
          return {
            index,
            bounds: {
              x: r?.left ?? 0,
              y: r?.top ?? 0,
              width: r?.width ?? 0,
              height: r?.height ?? 0
            }
          }
        })
        void api.setColumnLayout(slots)
      })
    }

    report()

    const strip = stripRef.current
    strip?.addEventListener('scroll', report, { passive: true })
    window.addEventListener('resize', report)
    const ro = new ResizeObserver(report)
    if (strip) ro.observe(strip)
    bodyRefs.current.forEach((el) => el && ro.observe(el))

    return () => {
      strip?.removeEventListener('scroll', report)
      window.removeEventListener('resize', report)
      ro.disconnect()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [columns, columnWidth, viewsSuspended])

  const username = (sessionId: string): string =>
    sessions.find((s) => s.id === sessionId)?.username || '?'

  return (
    <div className="column-strip" ref={stripRef}>
      {columns.map((column, index) => (
        <div className="column" key={`${column.sessionId}-${column.type}-${index}`} style={{ width: columnWidth }}>
          <div className="column-header">
            <span className="column-title">{COLUMN_TYPE_LABELS[column.type]}</span>
            <span className="column-subtitle">@{username(column.sessionId)}</span>
            <div className="column-header-spacer" />
            <button
              className="icon-btn column-back"
              type="button"
              title="Atrás"
              aria-label="Atrás"
              onClick={() => void onBack(index)}
            >
              <span aria-hidden="true">←</span>
            </button>
            <button
              className="btn icon ghost"
              type="button"
              title="Actualizar columna"
              aria-label="Actualizar columna"
              onClick={() => void onReload(index)}
            >
              <span className="icon-refresh" aria-hidden="true">
                ↻
              </span>
            </button>
            <button
              className="btn icon ghost"
              type="button"
              title="Mover izquierda"
              disabled={index === 0}
              onClick={() => void onMove(index, -1)}
            >
              ‹
            </button>
            <button
              className="btn icon ghost"
              type="button"
              title="Mover derecha"
              disabled={index === columns.length - 1}
              onClick={() => void onMove(index, 1)}
            >
              ›
            </button>
            <button
              className="btn icon danger"
              type="button"
              title="Cerrar"
              onClick={() => void onClose(index)}
            >
              ✕
            </button>
          </div>
          <div
            className="column-body"
            ref={(el) => {
              bodyRefs.current[index] = el
            }}
          />
        </div>
      ))}
    </div>
  )
}
