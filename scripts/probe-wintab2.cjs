const koffi = require('koffi')
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }

try {
  const wt = koffi.load('wintab32.dll')
  log('STEP loaded dll')

  // Use a concrete pointer type rather than `void *`; koffi handles typed
  // buffers more predictably that way.
  const WTInfoW = wt.func('uint __stdcall WTInfoW(uint wCategory, uint nIndex, uint8_t *lpOutput)')
  log('STEP bound WTInfoW')

  log('STEP available =', WTInfoW(0, 0, null))

  const sizeOf = (cat, idx) => WTInfoW(cat, idx, null)
  const read = (cat, idx, extra = 8) => {
    const n = sizeOf(cat, idx)
    if (!n) return null
    const buf = Buffer.alloc(n + extra)
    const written = WTInfoW(cat, idx, buf)
    return { n, written, buf: buf.subarray(0, n) }
  }

  log('STEP IFC_WINTABID size =', sizeOf(1, 1))
  const id = read(1, 1)
  log('STEP IFC_WINTABID =', id ? JSON.stringify(id.buf.toString('utf16le').replace(/\0+$/, '')) : 'null')

  const nDevBuf = Buffer.alloc(8)
  WTInfoW(1, 4, nDevBuf)
  const nDev = nDevBuf.readUInt32LE(0)
  log('STEP IFC_NDEVICES =', nDev)

  const specBuf = Buffer.alloc(8)
  WTInfoW(1, 2, specBuf)
  const spec = specBuf.readUInt16LE(0)
  log('STEP IFC_SPECVERSION =', `${spec >> 8}.${spec & 0xff}`)

  for (let i = 0; i < nDev; i++) {
    const cat = 100 + i
    const nm = read(cat, 1)
    log(`STEP dev${i} name =`, nm ? JSON.stringify(nm.buf.toString('utf16le').replace(/\0+$/, '')) : 'null')

    const rate = Buffer.alloc(8)
    WTInfoW(cat, 5, rate)
    log(`STEP dev${i} pktRateHz =`, rate.readUInt32LE(0))

    // AXIS { LONG min; LONG max; UINT units; FIX32 res; } = 16 bytes
    const ax = Buffer.alloc(32)
    const gotP = WTInfoW(cat, 15, ax) // DVC_NPRESSURE
    log(`STEP dev${i} pressure bytes=${gotP} min=${ax.readInt32LE(0)} max=${ax.readInt32LE(4)} levels=${ax.readInt32LE(4) - ax.readInt32LE(0) + 1}`)

    const or = Buffer.alloc(64)
    const gotO = WTInfoW(cat, 17, or) // DVC_ORIENTATION -> AXIS[3]
    log(`STEP dev${i} orientation bytes=${gotO} azimuthMax=${or.readInt32LE(4)} altitudeMax=${or.readInt32LE(20)} twistMax=${or.readInt32LE(36)}`)
  }
  log('STEP done')
} catch (e) {
  log('ERROR', String(e))
}
