import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AppConfigData, ColumnConfig } from '../../../shared/types'
import { DEFAULT_COLUMN_WIDTH, isColumnType, isInstagramUrl } from '../../../shared/types'

const DEFAULT_SETTINGS: AppConfigData = {
  $schema: './schema.json',
  columnWidth: DEFAULT_COLUMN_WIDTH,
  sessions: [],
  columns: []
}

const SCHEMA = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "$schema": { "type": "string" },
    "columnWidth": { "type": "integer", "minimum": 280 },
    "sessions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "username": { "type": "string" }
        },
        "required": ["id", "username"],
        "additionalProperties": false
      }
    },
    "columns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["feed", "messages", "reels", "explore", "profile", "notifications", "stories", "custom"]
          },
          "sessionId": { "type": "string" },
          "url": { "type": "string" }
        },
        "required": ["type", "sessionId"],
        "additionalProperties": false
      }
    }
  },
  "required": ["sessions", "columns"]
}
`

export function configDir(): string {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA
    if (appdata) return join(appdata, 'Fluxagram')
    return join(homedir(), 'AppData', 'Roaming', 'Fluxagram')
  }
  return join(homedir(), '.config', 'Fluxagram')
}

export function settingsFile(): string {
  return join(configDir(), 'settings.json')
}

export function schemaFile(): string {
  return join(configDir(), 'schema.json')
}

export function sessionDir(sessionId: string): string {
  return join(configDir(), 'sessions', sessionId)
}

export function cookiesFile(sessionId: string): string {
  return join(sessionDir(sessionId), 'cookies.json')
}

function ensureFiles(): void {
  mkdirSync(configDir(), { recursive: true })
  if (!existsSync(settingsFile())) {
    writeFileSync(settingsFile(), JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', 'utf8')
  }
  writeFileSync(schemaFile(), SCHEMA, 'utf8')
}

function sanitizeColumn(value: unknown): ColumnConfig | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { type?: unknown; sessionId?: unknown; url?: unknown }
  if (typeof raw.type !== 'string' || !isColumnType(raw.type)) return null
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null
  const column: ColumnConfig = { type: raw.type, sessionId: raw.sessionId }
  if (typeof raw.url === 'string' && raw.url) {
    column.url = raw.type === 'custom' && !isInstagramUrl(raw.url) ? null : raw.url
  }
  return column
}

export function loadConfig(): AppConfigData {
  ensureFiles()
  try {
    const raw = readFileSync(settingsFile(), 'utf8')
    const data = JSON.parse(raw) as AppConfigData
    const columns = Array.isArray(data.columns)
      ? data.columns.map(sanitizeColumn).filter((column): column is ColumnConfig => column !== null)
      : []
    return {
      $schema: data.$schema ?? './schema.json',
      columnWidth: data.columnWidth > 0 ? data.columnWidth : DEFAULT_COLUMN_WIDTH,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      columns
    }
  } catch {
    return { ...DEFAULT_SETTINGS, sessions: [], columns: [] }
  }
}

export function saveConfig(config: AppConfigData): void {
  ensureFiles()
  const out: AppConfigData = {
    $schema: config.$schema ?? './schema.json',
    columnWidth: config.columnWidth > 0 ? config.columnWidth : DEFAULT_COLUMN_WIDTH,
    sessions: config.sessions ?? [],
    columns: config.columns ?? []
  }
  writeFileSync(settingsFile(), JSON.stringify(out, null, 2) + '\n', 'utf8')
}
