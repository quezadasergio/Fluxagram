/// <reference types="vite/client" />

import type { FluxagramApi } from '../electron/preload/index'

declare global {
  interface Window {
    fluxagramApi: FluxagramApi
    fluxagram?: {
      send: (type: string, body: unknown) => void
    }
  }
}

export {}
