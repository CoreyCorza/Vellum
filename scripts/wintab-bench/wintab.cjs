/**
 * Minimal Wintab reader — the prototype for `src/main/wintab.ts`.
 *
 * Wintab is the tablet driver's own API: the one Krita uses by default and the
 * one Photoshop switches to when you set `UseSystemStylus 0`. It bypasses
 * WM_POINTER entirely, which means no Windows Ink, no OS-drawn pen rings, the
 * barrel button arrives as a plain bit, and pressure comes at the digitiser's
 * real resolution instead of WM_POINTER's 1024 steps.
 *
 * Delivery here is POLLING (`WTPacketsGet`) rather than WT_PACKET window
 * messages, because Electron cannot return a value from a window proc. Whether
 * polling is fast and steady enough is exactly what the bench measures.
 */
const koffi = require('koffi')

// --- WTI_* categories -------------------------------------------------------
const WTI_DEFSYSCTX = 4
const WTI_DEVICES = 100

// --- DVC_* indices ----------------------------------------------------------
const DVC_NAME = 1
const DVC_NPRESSURE = 15
const DVC_ORIENTATION = 17

// --- packet field bits (packet layout follows ASCENDING bit order) ----------
const PK_TIME = 0x0004
const PK_BUTTONS = 0x0040
const PK_X = 0x0080
const PK_Y = 0x0100
const PK_NORMAL_PRESSURE = 0x0400
const PK_ORIENTATION = 0x1000

const PACKET_FIELDS = PK_TIME | PK_BUTTONS | PK_X | PK_Y | PK_NORMAL_PRESSURE | PK_ORIENTATION
// time(4) buttons(4) x(4) y(4) pressure(4) orientation(12)
const PACKET_SIZE = 32

// --- LOGCONTEXTW field offsets (struct is 212 bytes) ------------------------
const LC_SIZE = 212
const LC = {
  options: 80,
  status: 84,
  locks: 88,
  msgBase: 92,
  device: 96,
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
}

const CXO_SYSTEM = 0x0001
const CXO_MESSAGES = 0x0004

class Wintab {
  constructor() {
    this.lib = koffi.load('wintab32.dll')
    // uint8_t* rather than void*: passing null for a `void *` out-param
    // corrupted the heap (0xC0000374) during the first probe.
    this.WTInfoW = this.lib.func('uint __stdcall WTInfoW(uint cat, uint idx, uint8_t *out)')
    this.WTOpenW = this.lib.func('void * __stdcall WTOpenW(void *hwnd, uint8_t *ctx, bool enable)')
    this.WTClose = this.lib.func('bool __stdcall WTClose(void *hctx)')
    this.WTPacketsGet = this.lib.func('int __stdcall WTPacketsGet(void *hctx, int max, uint8_t *pkts)')
    this.WTQueueSizeSet = this.lib.func('bool __stdcall WTQueueSizeSet(void *hctx, int n)')
    this.WTEnable = this.lib.func('bool __stdcall WTEnable(void *hctx, bool enable)')
    this.WTOverlap = this.lib.func('bool __stdcall WTOverlap(void *hctx, bool toTop)')

    this.hctx = null
    this.info = {}
    this.maxBatch = 128
    this.buf = Buffer.alloc(PACKET_SIZE * this.maxBatch)
  }

  available() {
    return this.WTInfoW(0, 0, null) > 0
  }

  capabilities() {
    const axis = (cat, idx) => {
      const b = Buffer.alloc(32)
      if (!this.WTInfoW(cat, idx, b)) return null
      return { min: b.readInt32LE(0), max: b.readInt32LE(4) }
    }
    const str = (cat, idx) => {
      const n = this.WTInfoW(cat, idx, null)
      if (!n) return null
      const b = Buffer.alloc(n + 8)
      this.WTInfoW(cat, idx, b)
      return b.subarray(0, n).toString('utf16le').replace(/\0+$/, '')
    }
    const press = axis(WTI_DEVICES, DVC_NPRESSURE)
    const orBuf = Buffer.alloc(64)
    this.WTInfoW(WTI_DEVICES, DVC_ORIENTATION, orBuf)
    return {
      device: str(WTI_DEVICES, DVC_NAME),
      pressure: press,
      pressureLevels: press ? press.max - press.min + 1 : null,
      azimuthMax: orBuf.readInt32LE(4),
      altitudeMax: orBuf.readInt32LE(20),
      twistMax: orBuf.readInt32LE(36)
    }
  }

  /** @param hwndBuffer result of BrowserWindow.getNativeWindowHandle() */
  open(hwndBuffer) {
    const ctx = Buffer.alloc(LC_SIZE)
    // Start from the default SYSTEM context so packet coordinates arrive in
    // screen pixels, already aligned with where the OS thinks the cursor is.
    if (!this.WTInfoW(WTI_DEFSYSCTX, 0, ctx)) throw new Error('WTInfoW(WTI_DEFSYSCTX) failed')

    let options = ctx.readUInt32LE(LC.options)
    options |= CXO_SYSTEM
    options &= ~CXO_MESSAGES // we poll; no window proc to receive WT_PACKET
    ctx.writeUInt32LE(options >>> 0, LC.options)

    ctx.writeUInt32LE(PACKET_FIELDS, LC.pktData)
    ctx.writeUInt32LE(0, LC.pktMode) // 0 = every field absolute
    ctx.writeUInt32LE(PK_X | PK_Y | PK_NORMAL_PRESSURE | PK_ORIENTATION, LC.moveMask)
    ctx.writeUInt32LE(0xffffffff, LC.btnDnMask)
    ctx.writeUInt32LE(0xffffffff, LC.btnUpMask)

    // Map tablet output onto the full virtual screen.
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysOrgX), LC.outOrgX)
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysOrgY), LC.outOrgY)
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysExtX), LC.outExtX)
    // Wintab's Y grows upward; negating the extent flips it to screen order.
    ctx.writeInt32LE(-Math.abs(ctx.readInt32LE(LC.sysExtY)), LC.outExtY)

    const hwndValue =
      hwndBuffer.length === 8 ? hwndBuffer.readBigUInt64LE(0) : BigInt(hwndBuffer.readUInt32LE(0))
    const hwnd = koffi.address(Number(hwndValue))

    this.hctx = this.WTOpenW(hwnd, ctx, true)
    if (!this.hctx) throw new Error('WTOpenW returned NULL — context could not be created')

    this.WTQueueSizeSet(this.hctx, this.maxBatch)
    this.WTOverlap(this.hctx, true)
    this.WTEnable(this.hctx, true)

    this.info = {
      pktRate: ctx.readUInt32LE(LC.pktRate),
      outOrgX: ctx.readInt32LE(LC.outOrgX),
      outOrgY: ctx.readInt32LE(LC.outOrgY),
      outExtX: ctx.readInt32LE(LC.outExtX),
      outExtY: ctx.readInt32LE(LC.outExtY),
      sysExtX: ctx.readInt32LE(LC.sysExtX),
      sysExtY: ctx.readInt32LE(LC.sysExtY)
    }
    return this.info
  }

  /** Drain the queue. Returns raw packets; empty array when nothing is pending. */
  poll() {
    if (!this.hctx) return []
    const n = this.WTPacketsGet(this.hctx, this.maxBatch, this.buf)
    if (n <= 0) return []
    const out = new Array(n)
    for (let i = 0; i < n; i++) {
      const o = i * PACKET_SIZE
      out[i] = {
        time: this.buf.readUInt32LE(o),
        buttons: this.buf.readUInt32LE(o + 4),
        x: this.buf.readInt32LE(o + 8),
        y: this.buf.readInt32LE(o + 12),
        pressure: this.buf.readUInt32LE(o + 16),
        azimuth: this.buf.readInt32LE(o + 20),
        altitude: this.buf.readInt32LE(o + 24),
        twist: this.buf.readInt32LE(o + 28)
      }
    }
    return out
  }

  close() {
    if (this.hctx) {
      this.WTClose(this.hctx)
      this.hctx = null
    }
  }
}

module.exports = { Wintab, PACKET_SIZE }
