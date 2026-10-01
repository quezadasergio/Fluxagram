import { useState } from 'react'
import type { ColumnConfig, ColumnType, SessionRecord } from '@shared/types'
import { COLUMN_TYPE_LABELS, isInstagramUrl } from '@shared/types'

interface Props {
  sessions: SessionRecord[]
  onCancel: () => void
  onAdd: (column: ColumnConfig) => void | Promise<void>
}

const TYPES: ColumnType[] = [
  'feed',
  'messages',
  'reels',
  'explore',
  'profile',
  'notifications',
  'stories',
  'custom'
]

export function AddColumnModal({ sessions, onCancel, onAdd }: Props) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '')
  const [type, setType] = useState<ColumnType>('feed')
  const [url, setUrl] = useState('')

  const canAdd = Boolean(sessionId) && (type !== 'custom' || isInstagramUrl(url))

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Añadir columna</h2>
        <label>
          Cuenta
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                @{s.username}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipo
          <select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {COLUMN_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          URL
          <input
            value={url}
            disabled={type !== 'custom'}
            placeholder="https://www.instagram.com/…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="btn"
            type="button"
            disabled={!canAdd}
            onClick={() =>
              void onAdd({
                type,
                sessionId,
                url: type === 'custom' ? url.trim() : undefined
              })
            }
          >
            Añadir
          </button>
        </div>
      </div>
    </div>
  )
}
