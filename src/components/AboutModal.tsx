import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/api'
import logoUrl from '../assets/logo.png'

const api = window.fluxagramApi

interface Props {
  onClose: () => void
}

export function AboutModal({ onClose }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void api.getAppInfo().then(setInfo)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal about-modal"
        role="dialog"
        aria-label="Acerca de Fluxagram"
        onClick={(e) => e.stopPropagation()}
      >
        <img className="about-logo" src={logoUrl} alt="Fluxagram" />
        <h2>{info?.name ?? 'Fluxagram'}</h2>
        <p className="about-version">Version {info?.version ?? '…'}</p>
        <p className="about-credit">
          Application created by{' '}
          <button
            type="button"
            className="about-link"
            onClick={() => {
              if (info?.authorUrl) void api.openExternal(info.authorUrl)
            }}
          >
            {info?.author ?? 'quezadasergio'}
          </button>
        </p>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
