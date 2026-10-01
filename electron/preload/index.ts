import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, AppState, PostMediaItem } from '../../shared/api'
import type { ColumnConfig, ColumnLayoutSlot, Rect } from '../../shared/types'

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('app:getState'),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
  onState: (cb: (state: AppState) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: AppState): void => cb(state)
    ipcRenderer.on('app:state', listener)
    return () => ipcRenderer.removeListener('app:state', listener)
  },
  startFirstLogin: (bounds: Rect): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('login:startFirst', bounds),
  startAddAccount: (bounds: Rect): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke('login:startAdd', bounds),
  setLoginBounds: (bounds: Rect): Promise<void> => ipcRenderer.invoke('login:setBounds', bounds),
  cancelLogin: (): Promise<void> => ipcRenderer.invoke('login:cancel'),
  setColumnLayout: (slots: ColumnLayoutSlot[]): Promise<void> =>
    ipcRenderer.invoke('columns:layout', slots),
  hideColumns: (): Promise<void> => ipcRenderer.invoke('columns:hide'),
  rebuildColumns: (): Promise<void> => ipcRenderer.invoke('columns:rebuild'),
  reloadAllColumns: (): Promise<void> => ipcRenderer.invoke('columns:reloadAll'),
  reloadColumn: (index: number): Promise<void> => ipcRenderer.invoke('columns:reload', index),
  goBackColumn: (index: number): Promise<void> => ipcRenderer.invoke('columns:back', index),
  explorePost: (link: string): Promise<PostMediaItem[]> => ipcRenderer.invoke('post:explore', link),
  savePostMedia: (item: PostMediaItem): Promise<boolean> => ipcRenderer.invoke('post:save', item),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  onColumnWheel: (cb: (deltaX: number) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, deltaX: number): void => cb(deltaX)
    ipcRenderer.on('columns:wheel', listener)
    return () => ipcRenderer.removeListener('columns:wheel', listener)
  },
  addColumn: (column: ColumnConfig): Promise<AppState> =>
    ipcRenderer.invoke('columns:add', column),
  removeColumn: (index: number): Promise<AppState> => ipcRenderer.invoke('columns:remove', index),
  moveColumn: (index: number, delta: number): Promise<AppState> =>
    ipcRenderer.invoke('columns:move', index, delta),
  removeSession: (sessionId: string): Promise<AppState> =>
    ipcRenderer.invoke('sessions:remove', sessionId)
}

contextBridge.exposeInMainWorld('fluxagramApi', api)

export type FluxagramApi = typeof api
