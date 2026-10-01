import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('fluxagram', {
  send: (type: string, body: unknown): void => {
    ipcRenderer.send('flux:message', { type, body })
  }
})
