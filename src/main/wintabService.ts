import { BrowserWindow, ipcMain, screen } from 'electron'
import {
  Wintab,
  beginHighResolutionTimers,
  endHighResolutionTimers,
  type WintabCapabilities,
  type WintabPacket
} from './wintab'

export interface WintabStatus {
  supported: boolean
  active: boolean
  caps: WintabCapabilities | null
  highResTimers: boolean
  pollMs: number
  reason?: string
}

/** Packet with coordinates already in renderer viewport CSS pixels. */
export interface WintabSample {
  t: number
  x: number
  y: number
  /** normalised 0..1 at full device resolution */
  pressure: number
  buttons: number
  /** 0..1, 0 = upright */
  tilt: number
  /** radians */
  twist: number
  inverted: boolean
}

const POLL_MS = 1

/**
 * Owns the Wintab context and pushes samples to the renderer.
 *
 * Coordinates are converted here rather than in the renderer because only the
 * main process knows the window's screen position and which display's scale
 * factor applies. The renderer receives viewport CSS pixels, identical in
 * meaning to a PointerEvent's clientX/clientY, so both input paths hand the
 * engine the same units.
 */
export class WintabService {
  private wintab: Wintab | null = null
  private timer: NodeJS.Timeout | null = null
  private caps: WintabCapabilities | null = null
  private reason: string | undefined
  private highRes = false
  private enabled = false

  constructor(private win: BrowserWindow) {}

  start(): WintabStatus {
    if (process.platform !== 'win32') {
      this.reason = 'Wintab is Windows-only; Pointer Events is correct elsewhere'
      return this.status()
    }
    try {
      this.wintab = new Wintab()
      if (!this.wintab.available()) throw new Error('no Wintab driver present')
      this.caps = this.wintab.capabilities()
      const { packetRate } = this.wintab.open(this.win)
      this.caps.packetRate = packetRate
      this.highRes = beginHighResolutionTimers()
      this.enabled = true
      this.timer = setInterval(() => this.pump(), POLL_MS)
    } catch (err) {
      this.reason = err instanceof Error ? err.message : String(err)
      this.wintab = null
    }
    return this.status()
  }

  setEnabled(on: boolean): WintabStatus {
    this.enabled = on && this.wintab !== null
    this.wintab?.enable(this.enabled)
    return this.status()
  }

  status(): WintabStatus {
    return {
      supported: this.wintab !== null,
      active: this.enabled && this.wintab !== null,
      caps: this.caps,
      highResTimers: this.highRes,
      pollMs: POLL_MS,
      reason: this.reason
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.wintab?.close()
    this.wintab = null
    endHighResolutionTimers()
  }

  private lastGoodPressure = 0
  /** Packets whose pressure field was outside the device range. */
  outOfRangePressure = 0

  private sanitisePressure(raw: number, pMax: number): number {
    if (!Number.isFinite(raw) || raw < 0 || raw > pMax) {
      this.outOfRangePressure++
      return this.lastGoodPressure
    }
    this.lastGoodPressure = raw / pMax
    return this.lastGoodPressure
  }

  private pump(): void {
    const wt = this.wintab
    if (!wt || !this.enabled || this.win.isDestroyed()) return
    // Packets keep queuing while we are in the background; draining without
    // forwarding stops a burst of stale input landing when focus returns.
    const packets = wt.poll()
    if (packets.length === 0 || !this.win.isFocused()) return

    const bounds = this.win.getContentBounds()
    // getDisplayMatching keeps this correct on mixed-DPI setups, where the
    // primary display's scale factor would be wrong.
    const scale = screen.getDisplayMatching(bounds).scaleFactor || 1
    const originX = bounds.x * scale
    const originY = bounds.y * scale
    const pMax = this.caps?.pressureMax || 1
    const altMax = this.caps?.altitudeMax || 900

    const samples: WintabSample[] = packets.map((p: WintabPacket) => ({
      t: p.t,
      x: (p.x - originX) / scale,
      y: (p.y - originY) / scale,
      // Out-of-range readings must be REJECTED, not clamped. pkNormalPressure is
      // read as unsigned, so a stray negative/sentinel value becomes enormous
      // and clamping would turn it into full pressure — manufacturing exactly
      // the spike we are trying to avoid. Carry the last good value instead.
      pressure: this.sanitisePressure(p.pressure, pMax),
      buttons: p.buttons,
      // altitude counts up from the surface, so tilt is its complement
      tilt: Math.min(1, Math.max(0, 1 - Math.abs(p.altitude) / altMax)),
      twist: ((p.twist / 10) * Math.PI) / 180,
      // NOTE: negative altitude as the inverted-pen signal is the conventional
      // reading but is UNVERIFIED on this hardware. PK_CURSOR would be the
      // rigorous route if the eraser end misbehaves.
      inverted: p.altitude < 0
    }))

    this.win.webContents.send('wintab:samples', samples)
  }
}

export function registerWintabIpc(service: WintabService): void {
  ipcMain.handle('wintab:status', () => service.status())
  ipcMain.handle('wintab:setEnabled', (_e, on: boolean) => service.setEnabled(on))
}
