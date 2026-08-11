/**
 * Why does a line drawn zoomed OUT come out wobblier than the same line drawn
 * zoomed IN, even with identical stabiliser settings?
 *
 * Feeds a mathematically straight line plus realistic digitiser noise — noise
 * injected in SCREEN space, because that is where it physically happens — at a
 * range of zoom levels, and measures how far the stabilised points end up from
 * the ideal line, in DOCUMENT pixels. Document pixels are what gets baked into
 * the artwork, so that is the number that survives after you zoom back out.
 *
 *   npm run stabiliser
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const ed = window.editor
    if (!ed) return { failed: true, reason: 'no editor' }

    // deterministic gaussian, so runs are comparable
    let seed = 12345
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const gauss = () => {
      const u = Math.max(1e-9, rand()), v = rand()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    }

    // Physical constants of the situation, all in SCREEN pixels.
    const NOISE_SCREEN = 0.35   // digitiser jitter, perpendicular, RMS
    const HAND_SPEED   = 320    // px/sec across the glass
    const RATE_HZ      = 200    // digitiser report rate
    const LEN_SCREEN   = 700    // how long a line the hand draws

    const run = (scale, stabilise, zoomComp = 0) => {
      seed = 12345 // same noise sequence for every configuration
      ed.camera.scale = scale
      ed.camera.rotation = 0
      ed.camera.cx = ed.doc.width / 2
      ed.camera.cy = ed.doc.height / 2
      ed.setBrush({ stabilise, stabiliseZoomComp: zoomComp,
                    size: 8, spacing: 0.08, pressureToSize: false, flow: 1, opacity: 1 })

      // a straight 45-degree line across the middle of the viewport
      const n = Math.round((LEN_SCREEN / HAND_SPEED) * RATE_HZ)
      const ax = ed.camera.vw / 2 - LEN_SCREEN / 2 / Math.SQRT2
      const ay = ed.camera.vh / 2 + LEN_SCREEN / 2 / Math.SQRT2
      const bx = ed.camera.vw / 2 + LEN_SCREEN / 2 / Math.SQRT2
      const by = ed.camera.vh / 2 - LEN_SCREEN / 2 / Math.SQRT2
      // unit normal of the ideal line, in screen space
      const dx = bx - ax, dy = by - ay
      const L = Math.hypot(dx, dy)
      const nx = -dy / L, ny = dx / L

      const raw = []
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const wobble = gauss() * NOISE_SCREEN
        raw.push({
          sx: ax + dx * t + nx * wobble,
          sy: ay + dy * t + ny * wobble,
          t: (i / RATE_HZ) * 1000
        })
      }

      const sp = (p) => {
        const d = ed.camera.screenToDoc(p.sx, p.sy)
        return { x: d.x, y: d.y, pressure: 1, tilt: 0, twist: 0, t: p.t }
      }

      ed.doc.active.surface.clear()
      ed.history.clear()
      ed.beginStroke(sp(raw[0]), false)
      for (let i = 1; i < raw.length; i++) ed.extendStroke(sp(raw[i]))
      const pts = ed.debugStrokePoints.map((p) => ({ x: p.x, y: p.y }))
      ed.endStroke()

      // ideal line in DOC space
      const A = ed.camera.screenToDoc(ax, ay)
      const B = ed.camera.screenToDoc(bx, by)
      const ddx = B.x - A.x, ddy = B.y - A.y
      const DL = Math.hypot(ddx, ddy)
      const dnx = -ddy / DL, dny = ddx / DL
      const dev = (p) => (p.x - A.x) * dnx + (p.y - A.y) * dny

      const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / Math.max(1, arr.length))

      const inputDoc = raw.map((p) => {
        const d = ed.camera.screenToDoc(p.sx, p.sy)
        return (d.x - A.x) * dnx + (d.y - A.y) * dny
      })
      const outDoc = pts.map(dev)

      // Lag: how far the last stabilised point trails the true pen position
      // ALONG the stroke, in screen px. Noise reduction is meaningless without
      // it — any filter looks good if you let it lag arbitrarily.
      const ux = ddx / DL, uy = ddy / DL
      const along = (p) => (p.x - A.x) * ux + (p.y - A.y) * uy
      const lastRaw = ed.camera.screenToDoc(raw[raw.length - 1].sx, raw[raw.length - 1].sy)
      const lagDoc = along(lastRaw) - along(pts[pts.length - 1])
      const lagScreen = lagDoc * scale

      return {
        zoom: scale,
        docSamplesPerPx: +(pts.length / DL).toFixed(3),
        inputRmsDoc: +rms(inputDoc).toFixed(4),
        outputRmsDoc: +rms(outDoc).toFixed(4),
        outputRmsAt100pct: +rms(outDoc).toFixed(4),
        reductionFactor: +(rms(inputDoc) / Math.max(1e-9, rms(outDoc))).toFixed(2),
        lagScreenPx: +lagScreen.toFixed(2),
        /** the figure of merit: attenuation bought per pixel of lag */
        reductionPerLagPx: +(
          rms(inputDoc) / Math.max(1e-9, rms(outDoc)) / Math.max(0.01, Math.abs(lagScreen))
        ).toFixed(3)
      }
    }

    // Consistency across zoom is the property that matters most: the slider
    // must mean the same thing at every zoom level.
    const consistency = [4, 2, 1, 0.5, 0.25].map((z) => {
      const r = run(z, 0.5, 0)
      return { zoom: z, reduction: r.reductionFactor, lagScreenPx: r.lagScreenPx }
    })

    const zooms = [4, 1, 0.25]
    const table = (comp) =>
      zooms.map((z) => {
        const r = run(z, 0.5, comp)
        return {
          zoom: z,
          inputRmsDoc: r.inputRmsDoc,
          outputRmsDoc: r.outputRmsDoc,
          reduction: r.reductionFactor
        }
      })

    /*
     * Algorithm head-to-head, run outside the engine on one shared noise
     * sequence so the only variable is the filter.
     *
     * Comparing raw noise reduction is meaningless — any filter wins if you let
     * it lag arbitrarily. The figure of merit is attenuation per pixel of lag.
     */
    const compare = () => {
      seed = 999
      const N = 600
      const stepPx = 1.6           // screen px between samples
      const noise = 0.35
      const pts = []
      for (let i = 0; i < N; i++) pts.push({ along: i * stepPx, perp: gauss() * noise })

      const stats = (out) => {
        const perpRms = Math.sqrt(out.reduce((s, p) => s + p.perp * p.perp, 0) / out.length)
        // lag = how far behind the true along-track position the output sits
        const lag = out.reduce((s, p, i) => s + (pts[i].along - p.along), 0) / out.length
        return { rms: perpRms, lag: Math.abs(lag) }
      }
      const inRms = Math.sqrt(pts.reduce((s, p) => s + p.perp * p.perp, 0) / N)

      // one-pole IIR, distance-parameterised (the previous implementation)
      const ema = (L) => {
        let a = pts[0].along, p = pts[0].perp
        const out = []
        for (let i = 0; i < N; i++) {
          const k = L <= 0 ? 1 : 1 - Math.exp(-stepPx / L)
          a += (pts[i].along - a) * k
          p += (pts[i].perp - p) * k
          out.push({ along: a, perp: p })
        }
        return out
      }
      // Gaussian FIR over a distance window (Krita's shape, the new one)
      const gaussFir = (windowPx) => {
        const sigma = windowPx / 3
        const t2 = 2 * sigma * sigma
        const out = []
        for (let i = 0; i < N; i++) {
          let sum = 0, a = 0, p = 0, peak = 0
          for (let j = i; j >= 0; j--) {
            const d = (i - j) * stepPx
            const w = Math.exp(-(d * d) / t2)
            if (peak === 0) peak = w
            else if (w * 100 < peak) break
            sum += w; a += w * pts[j].along; p += w * pts[j].perp
          }
          out.push({ along: a / sum, perp: p / sum })
        }
        return out
      }

      const rows = []
      for (const L of [1, 2, 4, 8, 16]) {
        const e = stats(ema(L))
        rows.push({ filter: 'ema', param: L,
                    reduction: +(inRms / e.rms).toFixed(3),
                    lagPx: +e.lag.toFixed(2),
                    reductionPerLagPx: +((inRms / e.rms - 1) / Math.max(0.01, e.lag)).toFixed(3) })
      }
      for (const W of [3, 6, 12, 24, 48]) {
        const g = stats(gaussFir(W))
        rows.push({ filter: 'gaussian', param: W,
                    reduction: +(inRms / g.rms).toFixed(3),
                    lagPx: +g.lag.toFixed(2),
                    reductionPerLagPx: +((inRms / g.rms - 1) / Math.max(0.01, g.lag)).toFixed(3) })
      }
      return rows
    }

    const out = {
      algorithmComparison: compare(),
      consistencyAcrossZoom: consistency,
      noStabiliser: zooms.map((z) => {
        const r = run(z, 0, 0)
        return { zoom: z, rmsDoc: r.outputRmsDoc, samplesPerDocPx: r.docSamplesPerPx }
      }),
      zoomComp0: table(0),
      zoomComp0_5: table(0.5),
      zoomComp1: table(1)
    }
    out.zoomComp2 = table(2)
    // Two things matter: how much wobble survives at 25%, and whether the
    // zoomed-in feel was left alone to get it.
    const summarise = (t) => ({
      wobbleAt25pct: t[2].outputRmsDoc,
      wobbleAt400pct: t[0].outputRmsDoc,
      reductionAt400pct: t[0].reduction,
      ratio: +(t[2].outputRmsDoc / t[0].outputRmsDoc).toFixed(1)
    })
    out.summary = {
      none: { wobbleAt25pct: out.noStabiliser[2].rmsDoc, wobbleAt400pct: out.noStabiliser[0].rmsDoc },
      zoomComp0: summarise(out.zoomComp0),
      zoomComp0_5: summarise(out.zoomComp0_5),
      zoomComp1: summarise(out.zoomComp1),
      zoomComp2: summarise(out.zoomComp2)
    }
    return out
  })()`)

  console.log('STABILISER ' + JSON.stringify(result, null, 2))
  app.exit(0)
})
