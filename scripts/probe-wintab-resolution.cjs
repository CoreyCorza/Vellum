/**
 * How much positional precision are we actually receiving?
 *
 * Our Wintab context is a SYSTEM context mapped to the virtual desktop, so
 * packets arrive as LONG screen pixels. If the digitiser's native resolution is
 * far higher than the screen, every packet is being quantised to a whole screen
 * pixel before we ever see it — which would show up as stair-stepping that gets
 * worse the further you zoom out, because one screen pixel is more document
 * pixels at low zoom.
 *
 * This compares the tablet's native axis extents against what we map onto.
 */
const koffi = require('koffi')
const log = (...a) => process.stdout.write(a.join(' ') + '\n')

const WTI_INTERFACE = 1
const WTI_DEFSYSCTX = 4
const WTI_DEFCONTEXT = 3
const WTI_DEVICES = 100

const DVC_NAME = 1
const DVC_X = 12
const DVC_Y = 13

// LOGCONTEXTW offsets
const LC = { name: 0, outOrgX: 148, outOrgY: 152, outExtX: 160, outExtY: 164,
             sysOrgX: 188, sysOrgY: 192, sysExtX: 196, sysExtY: 200 }

try {
  const wt = koffi.load('wintab32.dll')
  const WTInfoW = wt.func('uint __stdcall WTInfoW(uint cat, uint idx, uint8_t *out)')

  const axis = (cat, idx) => {
    const b = Buffer.alloc(32)
    if (!WTInfoW(cat, idx, b)) return null
    return {
      min: b.readInt32LE(0),
      max: b.readInt32LE(4),
      units: b.readUInt32LE(8),
      // FIX32: 16.16 fixed point
      resolution: b.readUInt32LE(12) / 65536
    }
  }

  const x = axis(WTI_DEVICES, DVC_X)
  const y = axis(WTI_DEVICES, DVC_Y)

  const sys = Buffer.alloc(212)
  WTInfoW(WTI_DEFSYSCTX, 0, sys)
  const dig = Buffer.alloc(212)
  WTInfoW(WTI_DEFCONTEXT, 0, dig)

  const out = {
    nativeAxisX: x,
    nativeAxisY: y,
    nativeCountsX: x ? x.max - x.min + 1 : null,
    nativeCountsY: y ? y.max - y.min + 1 : null,
    systemContext: {
      outExtX: sys.readInt32LE(LC.outExtX),
      outExtY: sys.readInt32LE(LC.outExtY),
      sysExtX: sys.readInt32LE(LC.sysExtX),
      sysExtY: sys.readInt32LE(LC.sysExtY)
    },
    digitizingContext: {
      outExtX: dig.readInt32LE(LC.outExtX),
      outExtY: dig.readInt32LE(LC.outExtY)
    }
  }

  // The number that matters: how many tablet counts collapse into one reported
  // unit under the mapping we currently use.
  const screenX = Math.abs(out.systemContext.outExtX) || 1
  out.precisionLossFactor = +(out.nativeCountsX / screenX).toFixed(2)
  out.quantisationStepScreenPx = 1
  out.note =
    out.precisionLossFactor > 1.5
      ? `Losing ~${out.precisionLossFactor}x precision: packets are whole screen pixels`
      : 'Screen mapping is close to native resolution'

  log(JSON.stringify(out, null, 2))
} catch (e) {
  log('ERROR ' + String(e))
}
