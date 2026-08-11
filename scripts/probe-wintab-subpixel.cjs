/**
 * Can we ask Wintab for sub-pixel coordinates?
 *
 * A system context reports whole screen pixels, discarding ~7x the precision
 * the digitiser actually has. lcOutOrg/lcOutExt define the context's output
 * coordinate space, so scaling them up by a constant should hand back
 * fixed-point screen pixels that we divide down ourselves — keeping the
 * driver's screen mapping while recovering the resolution.
 *
 * Opens a context, reads it back with WTGetW, and reports whether the scaled
 * extents were honoured.
 */
const { app, BrowserWindow } = require('electron')
const koffi = require('koffi')

const WTI_DEFSYSCTX = 4
const LC = { options: 80, pktData: 104, outOrgX: 148, outOrgY: 152,
             outExtX: 160, outExtY: 164, sysOrgX: 188, sysOrgY: 192,
             sysExtX: 196, sysExtY: 200 }
const SUBPIXEL = 32

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 600, height: 400, show: false })
  const out = {}
  try {
    const wt = koffi.load('wintab32.dll')
    const WTInfoW = wt.func('uint __stdcall WTInfoW(uint cat, uint idx, uint8_t *o)')
    const WTOpenW = wt.func('void * __stdcall WTOpenW(void *h, uint8_t *c, bool e)')
    const WTGetW = wt.func('bool __stdcall WTGetW(void *h, uint8_t *c)')
    const WTClose = wt.func('bool __stdcall WTClose(void *h)')

    const ctx = Buffer.alloc(212)
    WTInfoW(WTI_DEFSYSCTX, 0, ctx)

    const sysExtX = ctx.readInt32LE(LC.sysExtX)
    const sysExtY = ctx.readInt32LE(LC.sysExtY)
    out.requested = {
      outExtX: sysExtX * SUBPIXEL,
      outExtY: -Math.abs(sysExtY) * SUBPIXEL,
      subpixel: SUBPIXEL
    }

    ctx.writeInt32LE(ctx.readInt32LE(LC.sysOrgX) * SUBPIXEL, LC.outOrgX)
    ctx.writeInt32LE(ctx.readInt32LE(LC.sysOrgY) * SUBPIXEL, LC.outOrgY)
    ctx.writeInt32LE(sysExtX * SUBPIXEL, LC.outExtX)
    ctx.writeInt32LE(-Math.abs(sysExtY) * SUBPIXEL, LC.outExtY)

    const buf = win.getNativeWindowHandle()
    const hv = buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
    const hctx = WTOpenW(koffi.address(Number(hv)), ctx, true)
    out.opened = Boolean(hctx)

    if (hctx) {
      const back = Buffer.alloc(212)
      out.readBackOk = Boolean(WTGetW(hctx, back))
      out.applied = {
        outOrgX: back.readInt32LE(LC.outOrgX),
        outOrgY: back.readInt32LE(LC.outOrgY),
        outExtX: back.readInt32LE(LC.outExtX),
        outExtY: back.readInt32LE(LC.outExtY)
      }
      out.honoured =
        out.applied.outExtX === out.requested.outExtX &&
        out.applied.outExtY === out.requested.outExtY
      WTClose(hctx)
    }
    out.verdict = out.honoured
      ? `Sub-pixel accepted: divide packet coords by ${SUBPIXEL} for fractional screen px`
      : 'Driver overrode the output extents; needs a digitizing context instead'
  } catch (e) {
    out.error = String(e)
  }
  console.log('SUBPIXEL ' + JSON.stringify(out, null, 2))
  app.exit(out.honoured ? 0 : 1)
})
