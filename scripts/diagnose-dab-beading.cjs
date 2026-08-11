/**
 * Why does pressure->opacity produce regular dots along a stroke?
 *
 * Draws a dead-straight constant-pressure line, samples alpha along its centre
 * line, and reports the ripple amplitude plus its dominant period via
 * autocorrelation. If the period matches the dab interval, the beading is the
 * dab pattern showing through the accumulation rather than anything to do with
 * pressure itself.
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

    const Y = 700
    const X0 = 300
    const X1 = 1700

    const run = (opts) => {
      ed.setBrush(Object.assign({
        size: 24, hardness: 0.2, opacity: 1, flow: 1, spacing: 0.06,
        pressureToSize: false, pressureToOpacity: false, pressureCurve: 1,
        stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
        symmetry: 'none', color: '#000000'
      }, opts.brush))
      ed.doc.active.surface.clear()
      ed.history.clear()

      const n = 300
      const sp = (i) => ({
        x: X0 + ((X1 - X0) * i) / n, y: Y,
        pressure: opts.spike && spikeAt.has(i)
          ? 1.0 // one bad sample, the way a stray packet reads
          : (opts.pressureAt ? opts.pressureAt(i / n) : opts.pressure),
        tilt: 0, twist: 0, t: i * 5
      })
      ed.beginStroke(sp(0), false)
      for (let i = 1; i <= n; i++) ed.extendStroke(sp(i))
      ed.endStroke()

      // alpha profile along the centre line
      const w = ed.doc.width
      const d = ed.doc.active.surface.ctx.getImageData(X0, Y, X1 - X0, 1).data
      const prof = []
      for (let i = 0; i < X1 - X0; i++) prof.push(d[i * 4 + 3])

      // trim ends where the stroke ramps in/out
      const core = prof.slice(120, prof.length - 120)
      const mean = core.reduce((a, b) => a + b, 0) / core.length
      let min = 255, max = 0
      for (const v of core) { if (v < min) min = v; if (v > max) max = v }

      // autocorrelation to find the ripple period
      const centred = core.map((v) => v - mean)
      let bestLag = 0, bestScore = -Infinity
      for (let lag = 2; lag < 80; lag++) {
        let s = 0
        for (let i = 0; i + lag < centred.length; i++) s += centred[i] * centred[i + lag]
        s /= centred.length - lag
        if (s > bestScore) { bestScore = s; bestLag = lag }
      }

      const radius = ed.brush.size * 0.5
      const dabInterval = Math.max(0.55, radius * 2 * ed.brush.spacing)
      return {
        label: opts.label,
        perDabAlpha: +(ed.brush.flow * Math.pow(opts.pressure, ed.brush.pressureCurve)).toFixed(3),
        meanAlpha: +mean.toFixed(1),
        rippleAmplitude: max - min,
        ripplePercent: +(((max - min) / Math.max(1, mean)) * 100).toFixed(1),
        dominantPeriodPx: bestLag,
        dabIntervalPx: +dabInterval.toFixed(2),
        // an isolated dot is a LOCAL outlier, invisible to a period estimate
        darkestOutlierAboveMean: +(max - mean).toFixed(1),
        spikesRejected: ed.debugSpikesRejected
      }
    }

    /*
     * The earlier version of this script set stabilise:0 everywhere, which
     * bypasses the smoothing branch entirely — so it never exercised the
     * jitter-floor code that turned out to be the actual culprit. A test that
     * cannot reach the suspect proves nothing. These rows engage the stabiliser
     * so the smoothing path actually runs.
     */
    const withStabiliser = [
      run({ label: 'STAB 50%, pressure->opacity p=0.3', pressure: 0.3,
            brush: { pressureToOpacity: true, flow: 1, stabilise: 0.5,
                     stabiliseSpeedAdapt: 0.6 } }),
      run({ label: 'STAB 50%, alpha 1 (pressure->size instead)', pressure: 1,
            brush: { pressureToOpacity: false, pressureToSize: true, flow: 1,
                     stabilise: 0.5, stabiliseSpeedAdapt: 0.6 } })
    ]

    /*
     * The real symptom: isolated dark dots, not periodic beading. That is one
     * dab receiving far more alpha than its neighbours — a single-sample
     * pressure spike. Inject some and check they no longer print.
     */
    const spikeAt = new Set([60, 130, 200])
    const spikes = [
      run({ label: 'spikes + pressure->opacity', pressure: 0,
            pressureAt: () => 0.3,
            brush: { pressureToOpacity: true, flow: 1, stabilise: 0.4 },
            spike: true }),
      run({ label: 'spikes + pressure->size (should look clean either way)',
            pressure: 0, pressureAt: () => 0.3,
            brush: { pressureToOpacity: false, pressureToSize: true, flow: 1,
                     stabilise: 0.4 },
            spike: true })
    ]

    const rows = [
      run({ label: 'flow 1.0, no pressure->opacity', pressure: 1,
            brush: { pressureToOpacity: false, flow: 1 } }),
      run({ label: 'pressure->opacity, p=0.5', pressure: 0.5,
            brush: { pressureToOpacity: true, flow: 1 } }),
      run({ label: 'pressure->opacity, p=0.25', pressure: 0.25,
            brush: { pressureToOpacity: true, flow: 1 } }),
      run({ label: 'flow 0.25 directly (no pressure)', pressure: 1,
            brush: { pressureToOpacity: false, flow: 0.25 } }),
      run({ label: 'pressure->opacity p=0.25, spacing 2%', pressure: 0.25,
            brush: { pressureToOpacity: true, flow: 1, spacing: 0.02 } }),
      run({ label: 'pressure->opacity p=0.25, hardness 0.9', pressure: 0.25,
            brush: { pressureToOpacity: true, flow: 1, hardness: 0.9 } }),

      // very light touch — where 8-bit rounding of tiny per-dab alphas bites
      run({ label: 'pressure->opacity p=0.08 (light touch)', pressure: 0.08,
            brush: { pressureToOpacity: true, flow: 1 } }),
      run({ label: 'pressure->opacity p=0.03 (feather)', pressure: 0.03,
            brush: { pressureToOpacity: true, flow: 1 } }),

      // realistic: pressure QUANTISED the way a digitiser reports it, then a
      // smooth ramp for comparison
      run({ label: 'pressure ramp, smooth', pressure: 0,
            pressureAt: (u) => 0.05 + 0.6 * Math.sin(u * Math.PI),
            brush: { pressureToOpacity: true, flow: 1 } }),
      run({ label: 'pressure ramp + 1% noise', pressure: 0,
            pressureAt: (u) => {
              const base = 0.05 + 0.6 * Math.sin(u * Math.PI)
              return Math.max(0, base + (Math.sin(u * 977) * 0.01))
            },
            brush: { pressureToOpacity: true, flow: 1 } })
    ]
    return { spikes, withStabiliser, rows }
  })()`)

  console.log('BEADING ' + JSON.stringify(result, null, 2))
  app.exit(0)
})
