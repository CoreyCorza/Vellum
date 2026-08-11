import type { WintabSample } from '@engine/wintabInput'

export interface WintabStatus {
  supported: boolean
  active: boolean
  caps: {
    device: string | null
    pressureMax: number
    pressureLevels: number
    twistMax: number
    packetRate: number
  } | null
  highResTimers: boolean
  pollMs: number
  reason?: string
}

export interface InkwellApi {
  isElectron: true
  savePng(bytes: Uint8Array, defaultName: string): Promise<string | null>
  wintabStatus(): Promise<WintabStatus>
  wintabSetEnabled(on: boolean): Promise<WintabStatus>
  onWintabSamples(cb: (samples: WintabSample[]) => void): () => void
}

/** Wintab exists only inside Electron on Windows; everywhere else the browser
 *  path is already the right answer (Linux gets pressure via XInput2/tablet_v2). */
export async function wintabStatus(): Promise<WintabStatus | null> {
  const api = window.inkwell
  if (!api?.isElectron) return null
  try {
    return await api.wintabStatus()
  } catch {
    return null
  }
}

export function onWintabSamples(cb: (samples: WintabSample[]) => void): () => void {
  const api = window.inkwell
  if (!api?.isElectron) return () => undefined
  return api.onWintabSamples(cb)
}

export async function setWintabEnabled(on: boolean): Promise<WintabStatus | null> {
  const api = window.inkwell
  if (!api?.isElectron) return null
  return api.wintabSetEnabled(on)
}

declare global {
  interface Window {
    inkwell?: InkwellApi
  }
}

/**
 * The one place the renderer knows whether it is inside Electron.
 *
 * Everything else imports these functions, which is why `npm run dev:web` gives
 * you the whole editor in a browser tab — a far faster loop for brush-feel work
 * than restarting Electron on every change.
 */
export const isElectron = (): boolean => Boolean(window.inkwell?.isElectron)

export function defaultExportName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `inkwell-${stamp}.png`
}

/** @returns the saved path in Electron, `true` for a browser download, `null` if cancelled. */
export async function savePng(blob: Blob): Promise<string | boolean | null> {
  const name = defaultExportName()
  const api = window.inkwell
  if (api?.isElectron) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return api.savePng(bytes, name)
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return true
}
