import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState } from '@shared/api'
import type { ColumnConfig, Rect } from '@shared/types'
import { AboutModal } from './components/AboutModal'
import { AddColumnModal } from './components/AddColumnModal'
import { ColumnStrip } from './components/ColumnStrip'
import { DownloadPostButton } from './components/DownloadPostButton'

const api = window.fluxagramApi

function elementBounds(el: HTMLElement | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height
  }
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [showAddColumn, setShowAddColumn] = useState(false)
  const [showAddAccount, setShowAddAccount] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showDownload, setShowDownload] = useState(false)
  const loginSlotRef = useRef<HTMLDivElement>(null)
  const addAccountSlotRef = useRef<HTMLDivElement>(null)
  const firstLoginStarted = useRef(false)
  const sessionsBeforeAdd = useRef(0)

  const refresh = useCallback(async () => {
    const next = await api.getState()
    setState(next)
  }, [])

  useEffect(() => {
    void refresh()
    return api.onState(setState)
  }, [refresh])

  useEffect(() => {
    if (!showAddAccount || !state) return
    if (state.sessions.length > sessionsBeforeAdd.current) {
      setShowAddAccount(false)
    }
  }, [state, showAddAccount])

  useEffect(() => {
    if (!state || state.hasLoggedIn) {
      firstLoginStarted.current = false
      return
    }
    const start = async (): Promise<void> => {
      const bounds = elementBounds(loginSlotRef.current)
      if (!bounds || bounds.width < 10) {
        requestAnimationFrame(() => void start())
        return
      }
      if (firstLoginStarted.current) {
        await api.setLoginBounds(bounds)
        return
      }
      firstLoginStarted.current = true
      await api.startFirstLogin(bounds)
    }
    void start()

    const onResize = (): void => {
      const bounds = elementBounds(loginSlotRef.current)
      if (bounds) void api.setLoginBounds(bounds)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [state?.hasLoggedIn])

  useEffect(() => {
    if (!showAddAccount) return
    let cancelled = false
    const start = async (): Promise<void> => {
      const bounds = elementBounds(addAccountSlotRef.current)
      if (!bounds || bounds.width < 10) {
        requestAnimationFrame(() => {
          if (!cancelled) void start()
        })
        return
      }
      await api.startAddAccount(bounds)
    }
    void start()
    const onResize = (): void => {
      const bounds = elementBounds(addAccountSlotRef.current)
      if (bounds) void api.setLoginBounds(bounds)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
    }
  }, [showAddAccount])

  if (!state) {
    return (
      <div className="app">
        <div className="toolbar">
          <div className="app-title">Fluxagram</div>
        </div>
        <div className="empty-state">
          <p className="empty-body">Cargando…</p>
        </div>
      </div>
    )
  }

  const loggedIn = state.hasLoggedIn
  const modalOpen = showAddColumn || showAddAccount || showAbout || showDownload

  return (
    <div className="app">
      <div className="toolbar">
        <div className="app-title">Fluxagram</div>
        <div className="toolbar-spacer" />
        {loggedIn && (
          <>
            <button
              className="icon-btn"
              type="button"
              title="Acerca de Fluxagram"
              aria-label="Información"
              onClick={() => setShowAbout(true)}
            >
              <span className="icon-btn-label">i</span>
            </button>
            <DownloadPostButton onOpenChange={setShowDownload} />
            <button
              className="icon-btn"
              type="button"
              title="Refrescar columnas"
              aria-label="Refrescar"
              onClick={() => void api.reloadAllColumns()}
            >
              <span className="icon-refresh" aria-hidden="true">
                ↻
              </span>
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                sessionsBeforeAdd.current = state.sessions.length
                setShowAddAccount(true)
              }}
            >
              Añadir cuenta
            </button>
            <button className="btn" type="button" onClick={() => setShowAddColumn(true)}>
              Añadir columna
            </button>
          </>
        )}
        {!loggedIn && (
          <button
            className="icon-btn"
            type="button"
            title="Acerca de Fluxagram"
            aria-label="Información"
            onClick={() => setShowAbout(true)}
          >
            <span className="icon-btn-label">i</span>
          </button>
        )}
      </div>

      <div className="main">
        {loggedIn && state.columns.length > 0 && (
          <ColumnStrip
            columns={state.columns}
            sessions={state.sessions}
            columnWidth={state.columnWidth}
            viewsSuspended={modalOpen}
            onMove={async (index, delta) => setState(await api.moveColumn(index, delta))}
            onClose={async (index) => setState(await api.removeColumn(index))}
            onReload={(index) => void api.reloadColumn(index)}
            onBack={(index) => void api.goBackColumn(index)}
          />
        )}

        {loggedIn && state.columns.length === 0 && (
          <div className="empty-state">
            <h1 className="empty-title">Sin columnas</h1>
            <p className="empty-body">
              Añade una columna de feed, mensajes, reels, explorar, perfil, notificaciones, historias o una URL.
            </p>
            <button className="btn" type="button" onClick={() => setShowAddColumn(true)}>
              Añadir columna
            </button>
          </div>
        )}

        {!loggedIn && (
          <div className="overlay">
            <div className="first-login">
              <h1 className="empty-title">Bienvenido a Fluxagram</h1>
              <p className="empty-body">
                Inicia sesión en Instagram para empezar. Se detectará tu usuario automáticamente.
              </p>
              <div className="login-slot" ref={loginSlotRef} />
            </div>
          </div>
        )}
      </div>

      {showAddColumn && (
        <AddColumnModal
          sessions={state.sessions}
          onCancel={() => setShowAddColumn(false)}
          onAdd={async (column: ColumnConfig) => {
            setState(await api.addColumn(column))
            setShowAddColumn(false)
          }}
        />
      )}

      {showAddAccount && (
        <div className="modal-backdrop">
          <div className="modal login-modal">
            <h2>Añadir cuenta</h2>
            <p className="empty-body">Inicia sesión en Instagram. Se detectará tu usuario automáticamente.</p>
            <div className="login-modal-slot" ref={addAccountSlotRef} />
            <div className="modal-actions">
              <button
                className="btn ghost"
                type="button"
                onClick={async () => {
                  await api.cancelLogin()
                  setShowAddAccount(false)
                  await refresh()
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  )
}
