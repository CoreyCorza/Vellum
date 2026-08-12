import { contextBridge, ipcRenderer } from 'electron'

/**
 * The entire native surface area, deliberately tiny.
 *
 * contextIsolation is on and nodeIntegration is off, so the renderer cannot
 * reach the filesystem except through the calls listed here. Keep it that way —
 * every addition is a hole in the sandbox.
 */
const api = {
  isElectron: true as const,
  savePng: (bytes: Uint8Array, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('file:savePng', bytes, defaultName),
  saveText: (text: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('file:saveText', text, defaultName),

  // --- Wintab pen input -----------------------------------------------------
  wintabStatus: (): Promise<unknown> => ipcRenderer.invoke('wintab:status'),
  wintabSetEnabled: (on: boolean): Promise<unknown> =>
    ipcRenderer.invoke('wintab:setEnabled', on),
  onWintabSamples: (cb: (samples: unknown[]) => void): (() => void) => {
    const handler = (_e: unknown, samples: unknown[]): void => cb(samples)
    ipcRenderer.on('wintab:samples', handler)
    return () => ipcRenderer.off('wintab:samples', handler)
  }
}

export type VellumApi = typeof api

contextBridge.exposeInMainWorld('vellum', api)
