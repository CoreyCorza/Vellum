import type { BrowserWindow } from 'electron'

/**
 * Wintab input source.
 *
 * Wintab is the tablet driver's own API — what Krita uses by default, and what
 * Photoshop switches to when you set `UseSystemStylus 0`. It bypasses
 * WM_POINTER entirely, which buys us four things:
 *
 *   · pressure at the digitiser's real resolution (16,384 levels on the XP-Pen
 *     measured here) instead of WM_POINTER's 1024
 *   · input that survives "Use Windows Ink" being switched off in the driver
 *   · no OS-drawn pen rings, because no WM_POINTER right-click is generated
 *   · the barrel button as a plain bit, ours to bind
 *
 * Delivery is POLLING, not WT_PACKET window messages, because Electron cannot
 * return a value from a window proc. Benchmarked on real strokes: poll gap p95
 * 3.08 ms, 1.01 packets per poll at a 194 Hz device rate — i.e. the queue is
 * drained as fast as it fills. That only holds with 1 ms timers; see
 * `beginHighResolutionTimers`.
 */

// WTI_* categories
const WTI_DEFSYSCTX = 4
const WTI_DEVICES = 100

// DVC_* indices
const DVC_NAME = 1
const DVC_NPRESSURE = 15
const DVC_ORIENTATION = 17

// Packet field bits. The packet struct lays fields out in ASCENDING bit order.
const PK_TIME = 0x0004
const PK_BUTTONS = 0x0040
const PK_X = 0x0080
const PK_Y = 0x0100
const PK_NORMAL_PRESSURE = 0x0400
const PK_ORIENTATION = 0x1000

const PACKET_FIELDS = PK_TIME | PK_BUTTONS | PK_X | PK_Y | PK_NORMAL_PRESSURE | PK_ORIENTATION
/** time(4) buttons(4) x(4) y(4) pressure(4) orientation(3x4) */
const PACKET_SIZE = 32

// LOGCONTEXTW is 212 bytes; these are byte offsets into it.
const LC_SIZE = 212
const LC = {
  options: 80,
  pktRate: 100,
  pktData: 104,
  pktMode: 108,
  moveMask: 112,
  btnDnMask: 116,
  btnUpMask: 120,
  outOrgX: 148,
  outOrgY: 152,
  outExtX: 160,
  outExtY: 164,
  sysOrgX: 188,
  sysOrgY: 192,
  sysExtX: 196,
  sysExtY: 200
} as const

const CXO_SYSTEM = 0x0001
const CXO_MESSAGES = 0x0004

/**
 * Fixed-point denominator for packet coordinates.
 *
 * A default system context reports whole virtual-screen pixels. Measured on
 * this tablet that throws away 7x the precision on X and 13.7x on Y — the
 * digitiser resolves 44801 x 29601 counts and we were mapping onto 6400 x 2160.
 * The visible result is stair-stepping that gets proportionally worse as you
 * zoom out, because one screen pixel becomes several document pixels.
 *
 * lcOutOrg/lcOutExt define the context's output coordinate space, so scaling
 * them by this factor yields fixed-point screen pixels while keeping the
 * driver's own screen mapping intact. Verified honoured via WTGetW — the driver
 * echoes the scaled extents back rather than overriding them.
 *
 * 32 is comfortably past the 13.7x worst axis and keeps values far inside
 * LONG range.
 */
const SUBPIXEL = 32

export interface WintabPacket {
  /** device time in ms — quantised to ~15.6ms by GetTickCount, do not use for latency */
  t: number
  /** virtual-screen physical pixels, FRACTIONAL (already divided by SUBPIXEL) */
  x: number
  y: number
  /** raw, 0..pressureMax */
  pressure: number
  buttons: number
  azimuth: number
  altitude: number
  twist: number
}

export interface WintabCapabilities {
  device: string | null
  pressureMax: number
  pressureLevels: number
  azimuthMax: number
  altitudeMax: number
  twistMax: number
  packetRate: number
}

/**
 * Windows' default timer granularity is 15.6 ms, so `setInterval(1)` silently
 * becomes `setInterval(15.6)` and the poll loop falls three packets behind on
 * every tick. Measured here: p50 15.56 ms -> 2.22 ms after this call, a 7x
 * improvement, which is the difference between polling being viable and not.
 * Scoped to this process on Windows 10 2004+, so the power cost is ours.
 */
let timerPeriodActive = false
export function beginHighResolutionTimers(): boolean {
  if (process.platform !== 'win32' || timerPeriodActive) return timerPeriodActive
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as typeof import('koffi')
    const winmm = koffi.load('winmm.dll')
    const timeBeginPeriod = winmm.func('uint __stdcall timeBeginPeriod(uint uPeriod)')
    timerPeriodActive = timeBeginPeriod(1) === 0 // TIMERR_NOERROR
  } catch {
    timerPeriodActive = false
  }
  return timerPeriodActive
}

export function endHighResolutionTimers(): void {
  if (!timerPeriodActive) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as typeof import('koffi')
    koffi.load('winmm.dll').func('uint __stdcall timeEndPeriod(uint uPeriod)')(1)
  } catch {
    /* exiting anyway */
  }
  timerPeriodActive = false
}

export class Wintab {
  private lib: ReturnType<typeof import('koffi').load>
  private koffi: typeof import('koffi')
  private WTInfoW: (cat: number, idx: number, out: Buffer | null) => number
  private WTOpenW: (hwnd: unknown, ctx: Buffer, enable: boolean) => unknown
  private WTClose: (hctx: unknown) => boolean
  private WTPacketsGet: (hctx: unknown, max: number, pkts: Buffer) => number
  private WTQueueSizeSet: (hctx: unknown, n: number) => boolean
  private WTEnable: (hctx: unknown, enable: boolean) => boolean
  private WTOverlap: (hctx: unknown, toTop: boolean) => boolean

  private hctx: unknown = null
  private readonly maxBatch = 128
  private readonly buf = Buffer.alloc(PACKET_SIZE * 128)

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    this.koffi = require('koffi') as typeof import('koffi')
    this.lib = this.koffi.load('wintab32.dll')
    // uint8_t* rather than void*: passing null for a `void *` out-param
    // corrupted the heap (0xC0000374) during the first probe of this API.
    this.WTInfoW = this.lib.func('uint __stdcall WTInfoW(uint cat, uint idx, uint8_t *out)')
    this.WTOpenW = this.lib.func('void * __stdcall WTOpenW(void *hwnd, uint8_t *ctx, bool enable)')
    this.WTClose = this.lib.func('bool __stdcall WTClose(void *hctx)')
    this.WTPacketsGet = this.lib.func('int __stdcall WTPacketsGet(void *hctx, int max, uint8_t *pkts)')
    this.WTQueueSizeSet = this.lib.func('bool __stdcall WTQueueSizeSet(void *hctx, int n)')
    this.WTEnable = this.lib.func('bool __stdcall WTEnable(void *hctx, bool enable)')
    this.WTOverlap = this.lib.func('bool __stdcall WTOverlap(void *hctx, bool toTop)')
  }

  available(): boolean {
    return this.WTInfoW(0, 0, null) > 0
  }

  capabilities(): WintabCapabilities {
    const str = (cat: number, idx: number): string | null => {
      const n = this.WTInfoW(cat, idx, null)
      if (!n) return null
      const b = Buffer.alloc(n + 8)
      this.WTInfoW(cat, idx, b)
      return b.subarray(0, n).toString('utf16le').replace(/\0+$/, '').trim()
    }
    const pressBuf = Buffer.alloc(32)
    this.WTInfoW(WTI_DEVICES, DVC_NPRESSURE, pressBuf)
    const orBuf = Buffer.alloc(64)
    this.WTInfoW(WTI_DEVICES, DVC_ORIENTATION, orBuf)
    const max = pressBuf.readInt32LE(4)
    return {
      device: str(WTI_DEVICES, DVC_NAME),
      pressureMax: max,
      pressureLevels: max - pressBuf.readInt32LE(0) + 1,
      azimuthMax: orBuf.readInt32LE(4),
      altitudeMax: orBuf.readInt32LE(20),
      twistMax: orBuf.readInt32LE(36),
      packetRate: 0
    }
  }

  open(win: BrowserWindow): { packetRate: number } {
    const ctx = Buffer.alloc(LC_SIZE)
    // Start from the default SYSTEM context so packet coordinates arrive in
    // virtual-screen pixels, already aligned with where the OS cursor is.
    if (!this.WTInfoW(WTI_DEFSYSCTX, 0, ctx)) throw new Error('WTInfoW(WTI_DEFSYSCTX) failed')

    let options = ctx.readUInt32LE(LC.options)
    options |= CXO_SYSTEM
    options &= ~CXO_MESSAGES // we poll; there is no window proc to receive WT_PACKET
    ctx.writeUInt32LE(options >>> 0, LC.options)

    ctx.writeUInt32LE(PACKET_FIELDS, LC.pktData)
    ctx.writeUInt32LE(0, LC.pktMode) // every field absolute
    ctx.writeUInt32LE(PK_X | PK_Y | PK_NORMAL_PRESSURE | PK_ORIENTATION, LC.moveMask)
    ctx.writeUInt32LE(0xffffffff, LC.btnDnMask)
    ctx.writeUInt32LE(0xffffffff, LC.btnUpMask)

    // Scaled by SUBPIXEL so packets arrive as fixed-point screen pixels.
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysOrgX) * SUBPIXEL, LC.outOrgX)
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysOrgY) * SUBPIXEL, LC.outOrgY)
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysExtX) * SUBPIXEL, LC.outExtX)
    // Wintab's Y grows upward; a negative extent flips it into screen order.
    ctx.writeInt32LE(-Math.abs(ctx.readInt32LE(LC.sysExtY)) * SUBPIXEL, LC.outExtY)

    const buf = win.getNativeWindowHandle()
    const hwndValue = buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
    const hwnd = this.koffi.address(Number(hwndValue))

    this.hctx = this.WTOpenW(hwnd, ctx, true)
    if (!this.hctx) throw new Error('WTOpenW returned NULL')

    this.WTQueueSizeSet(this.hctx, this.maxBatch)
    this.WTOverlap(this.hctx, true)
    this.WTEnable(this.hctx, true)

    return { packetRate: ctx.readUInt32LE(LC.pktRate) }
  }

  get isOpen(): boolean {
    return this.hctx !== null
  }

  /** Drain the queue. Empty array when nothing is pending — the common case. */
  poll(): WintabPacket[] {
    if (!this.hctx) return []
    const n = this.WTPacketsGet(this.hctx, this.maxBatch, this.buf)
    if (n <= 0) return []
    const out: WintabPacket[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const o = i * PACKET_SIZE
      out[i] = {
        t: this.buf.readUInt32LE(o),
        buttons: this.buf.readUInt32LE(o + 4),
        // fixed-point -> fractional screen pixels
        x: this.buf.readInt32LE(o + 8) / SUBPIXEL,
        y: this.buf.readInt32LE(o + 12) / SUBPIXEL,
        pressure: this.buf.readUInt32LE(o + 16),
        azimuth: this.buf.readInt32LE(o + 20),
        altitude: this.buf.readInt32LE(o + 24),
        twist: this.buf.readInt32LE(o + 28)
      }
    }
    return out
  }

  enable(on: boolean): void {
    if (this.hctx) this.WTEnable(this.hctx, on)
  }

  close(): void {
    if (this.hctx) {
      this.WTClose(this.hctx)
      this.hctx = null
    }
  }
}
