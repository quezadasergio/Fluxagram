export type ColumnType =
  | 'feed'
  | 'messages'
  | 'reels'
  | 'explore'
  | 'profile'
  | 'notifications'
  | 'stories'
  | 'custom'

export interface SessionRecord {
  id: string
  username: string
}

export interface ColumnConfig {
  type: ColumnType
  sessionId: string
  url?: string | null
}

export interface AppConfigData {
  $schema?: string
  columnWidth: number
  sessions: SessionRecord[]
  columns: ColumnConfig[]
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ColumnLayoutSlot {
  index: number
  bounds: Rect
}

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  feed: 'Feed',
  messages: 'Mensajes',
  reels: 'Reels',
  explore: 'Explorar',
  profile: 'Perfil',
  notifications: 'Notificaciones',
  stories: 'Historias',
  custom: 'URL'
}

export const COLUMN_TYPES = Object.keys(COLUMN_TYPE_LABELS) as ColumnType[]

export const DEFAULT_COLUMN_WIDTH = 780

export const LOGIN_URL = 'https://www.instagram.com/accounts/login/'

export const HOME_URL = 'https://www.instagram.com/'

export function isColumnType(value: string): value is ColumnType {
  return Object.prototype.hasOwnProperty.call(COLUMN_TYPE_LABELS, value)
}

export function isInstagramUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'instagram.com' || url.hostname === 'www.instagram.com')
    )
  } catch {
    return false
  }
}

export function columnUrl(
  type: ColumnType,
  username: string | undefined,
  customUrl?: string | null
): string {
  const user = encodeURIComponent(username ?? '')
  switch (type) {
    case 'feed':
      return HOME_URL
    case 'messages':
      return 'https://www.instagram.com/direct/inbox/'
    case 'reels':
      return 'https://www.instagram.com/reels/'
    case 'explore':
      return 'https://www.instagram.com/explore/'
    case 'notifications':
      return 'https://www.instagram.com/accounts/activity/'
    case 'profile':
      return `https://www.instagram.com/${user}/`
    case 'stories':
      return `https://www.instagram.com/stories/${user}/`
    case 'custom':
      return customUrl && isInstagramUrl(customUrl) ? customUrl.trim() : HOME_URL
  }
}

export function partitionName(sessionId: string): string {
  return `persist:fluxagram-${sessionId}`
}

export const PARTITION_PREFIX = 'persist:fluxagram-'
