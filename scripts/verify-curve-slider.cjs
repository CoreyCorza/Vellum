/**
 * Is "Curve smoothing" a real continuous dial?
 *
 * Drives a deliberate zig-zag and measures how far the painted path bulges away
 * from the straight polyline through the samples. That bulge IS the spline's
 * contribution, so it should fall smoothly to exactly zero at 0%.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const ed = window.editor
    ed.camera.scale = 1
    ed.camera.rotation = 0
    ed.camera.cx = ed.doc.width / 2
    ed.camera.cy = ed.doc.height / 2

    // A zig-zag maximises the difference between a spline and a polyline.
    const corners = []
    for (let i = 0; i <= 8; i++) {
      corners.push({ x: 400 + i * 140, y: 600 + (i % 2 === 0 ? -110 : 110) })
    }

    // Distance from a point to the polyline through the corners.
    const distToPolyline = (px, py) => {
      let best = Infinity
      for (let i = 0; i < corners.length - 1; i++) {
        const a = corners[i], b = corners[i + 1]
        const vx = b.x - a.x, vy = b.y - a.y
        const L2 = vx * vx + vy * vy
        let t = L2 ? ((px - a.x) * vx + (py - a.y) * vy) / L2 : 0
        t = Math.max(0, Math.min(1, t))
        best = Math.min(best, Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t)))
      }
      return best
    }

    const run = (curve) => {
      ed.setBrush({ stabilise: 0, stabiliseJitterFloor: 0, stabiliseSpeedAdapt: 0,
                    pathSmoothness: curve, size: 6, spacing: 0.2,
                    pressureToSize: false, flow: 1, opacity: 1 })
      ed.doc.active.surface.clear()
      ed.history.clear()

      // Sample the painted result: scan the layer and find inked pixels that sit
      // furthest from the polyline.
      const sp = (c) => ({ x: c.x, y: c.y, pressure: 1, tilt: 0, twist: 0, t: performance.now() })
      ed.beginStroke(sp(corners[0]), false)
      for (let i = 1; i < corners.length; i++) ed.extendStroke(sp(corners[i]))
      ed.endStroke()

      const w = ed.doc.width, h = ed.doc.height
      const d = ed.doc.active.surface.ctx.getImageData(0, 0, w, h).data
      let maxDev = 0, inked = 0
      for (let y = 400; y < 820; y += 2) {
        for (let x = 350; x < 1600; x += 2) {
          if (d[(y * w + x) * 4 + 3] > 40) { inked++; maxDev = Math.max(maxDev, distToPolyline(x, y)) }
        }
      }
      return { curve, maxDeviationFromPolyline: +maxDev.toFixed(2), inkedSamples: inked }
    }

    const rows = [0, 0.25, 0.5, 0.75, 1].map(run)
    // brush radius is 3, so ink legitimately sits up to ~3px off the centre line
    const BRUSH_SLOP = 3.5
    const monotonic = rows.every((r, i) =>
      i === 0 || r.maxDeviationFromPolyline >= rows[i - 1].maxDeviationFromPolyline - 0.01)
    return {
      rows,
      allDrewInk: rows.every((r) => r.inkedSamples > 0),
      polylineExactAtZero: rows[0].maxDeviationFromPolyline <= BRUSH_SLOP,
      splineBulgesAtOne: rows[4].maxDeviationFromPolyline > rows[0].maxDeviationFromPolyline + 2,
      monotonic,
      failed: !(rows.every((r) => r.inkedSamples > 0) &&
                rows[0].maxDeviationFromPolyline <= BRUSH_SLOP &&
                rows[4].maxDeviationFromPolyline > rows[0].maxDeviationFromPolyline + 2 &&
                monotonic)
    }
  })()`)

  console.log('CURVE ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
