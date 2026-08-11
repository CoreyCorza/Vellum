/**
 * Pressure response curves.
 *
 * Checks the maths (monotone, no overshoot, endpoints honoured) and — more
 * importantly — that editing a curve actually changes the PAINTED result. A
 * curve widget that draws a pretty line but never reaches the brush engine
 * would look completely correct on screen.
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

  const result = await win.webContents.executeJavaScript(String.raw`(async () => {
    const ed = window.editor
    const { CurveSampler, LINEAR_CURVE, gammaCurve, withPointAdded, withPointMoved,
            withPointRemoved } = await import('/src/engine/brush/curve.ts').catch(() => ({}))
    const R = {}

    // The bundle is built, so import() of source will not resolve — reach the
    // sampler through the engine instead by measuring painted output.
    R.moduleImported = typeof CurveSampler === 'function'

    ed.camera.scale = 1
    ed.camera.rotation = 0
    ed.camera.cx = ed.doc.width / 2
    ed.camera.cy = ed.doc.height / 2

    const Y = 700
    const X0 = 400
    const X1 = 1600

    // Paint a constant-pressure line and report the stroke width in document px.
    const widthAt = (curve, pressure) => {
      ed.setBrush({
        size: 60, hardness: 0.95, opacity: 1, flow: 1, spacing: 0.05,
        pressureToSize: true, pressureToOpacity: false, minSize: 0,
        sizeCurve: curve, stabilise: 0, stabiliseSpeedAdapt: 0, symmetry: 'none',
        color: '#000000'
      })
      ed.doc.active.surface.clear()
      ed.history.clear()
      const n = 120
      const sp = (i) => ({ x: X0 + ((X1 - X0) * i) / n, y: Y, pressure,
                           tilt: 0, twist: 0, t: i * 5 })
      ed.beginStroke(sp(0), false)
      for (let i = 1; i <= n; i++) ed.extendStroke(sp(i))
      ed.endStroke()

      const w = ed.doc.width
      const col = ed.doc.active.surface.ctx.getImageData(1000, 0, 1, ed.doc.height).data
      let count = 0
      for (let y = 0; y < ed.doc.height; y++) if (col[y * 4 + 3] > 40) count++
      return count
    }

    // ---- linear curve: width should track pressure proportionally ---------
    const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    const linHalf = widthAt(lin, 0.5)
    const linFull = widthAt(lin, 1.0)
    R.linear = { half: linHalf, full: linFull,
                 halfIsAboutHalf: Math.abs(linHalf / linFull - 0.5) < 0.08 }

    // ---- a curve pulled DOWN must make mid pressure thinner ---------------
    const low = [{ x: 0, y: 0 }, { x: 0.5, y: 0.15 }, { x: 1, y: 1 }]
    const lowHalf = widthAt(low, 0.5)
    R.pulledDown = { half: lowHalf, thinnerThanLinear: lowHalf < linHalf * 0.6 }

    // ---- pulled UP must make mid pressure fatter --------------------------
    const high = [{ x: 0, y: 0 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 }]
    const highHalf = widthAt(high, 0.5)
    R.pulledUp = { half: highHalf, fatterThanLinear: highHalf > linHalf * 1.4 }

    // ---- endpoints must be honoured exactly -------------------------------
    R.endpoints = {
      zeroPressureIsThin: widthAt(lin, 0.02) < linFull * 0.15,
      fullPressureMatches: Math.abs(widthAt(high, 1.0) - linFull) <= 2
    }

    // ---- monotone: no overshoot above the highest control point -----------
    // A plain spline through these would bulge past y=1 between the last two
    // points; a monotone one cannot.
    const steep = [{ x: 0, y: 0 }, { x: 0.85, y: 1 }, { x: 1, y: 1 }]
    const steepMax = widthAt(steep, 0.92)
    R.noOvershoot = { widthAt92: steepMax, atOrBelowFull: steepMax <= linFull + 2 }

    // ---- opacity curve reaches the engine too -----------------------------
    const inkFor = (curve) => {
      ed.setBrush({
        size: 40, hardness: 0.95, opacity: 1, flow: 1, spacing: 0.05,
        pressureToSize: false, pressureToOpacity: true, opacityCurve: curve,
        stabilise: 0, symmetry: 'none', color: '#000000'
      })
      ed.doc.active.surface.clear()
      ed.history.clear()
      const n = 120
      const sp = (i) => ({ x: X0 + ((X1 - X0) * i) / n, y: Y, pressure: 0.5,
                           tilt: 0, twist: 0, t: i * 5 })
      ed.beginStroke(sp(0), false)
      for (let i = 1; i <= n; i++) ed.extendStroke(sp(i))
      ed.endStroke()
      const d = ed.doc.active.surface.ctx.getImageData(1000, Y, 1, 1).data
      return d[3]
    }
    const opacLinear = inkFor(lin)
    const opacLow = inkFor(low)
    R.opacityCurve = { linear: opacLinear, pulledDown: opacLow,
                       lighter: opacLow < opacLinear }

    // ---- flow curve reaches the engine, and composes with opacity ---------
    const inkForFlow = (opts) => {
      // flow 0.12, not 1: at full flow the accumulation saturates to 255 with
      // or without the dynamic, and the comparison measures nothing.
      ed.setBrush(Object.assign({
        size: 40, hardness: 0.95, opacity: 1, flow: 0.12, spacing: 0.05,
        pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
        opacityCurve: lin, flowCurve: lin,
        stabilise: 0, symmetry: 'none', color: '#000000'
      }, opts))
      ed.doc.active.surface.clear()
      ed.history.clear()
      const n = 120
      const sp = (i) => ({ x: X0 + ((X1 - X0) * i) / n, y: Y, pressure: 0.35,
                           tilt: 0, twist: 0, t: i * 5 })
      ed.beginStroke(sp(0), false)
      for (let i = 1; i <= n; i++) ed.extendStroke(sp(i))
      ed.endStroke()
      return ed.doc.active.surface.ctx.getImageData(1000, Y, 1, 1).data[3]
    }
    const flowOff = inkForFlow({})
    const flowLinear = inkForFlow({ pressureToFlow: true })
    const flowPulledDown = inkForFlow({ pressureToFlow: true, flowCurve: low })
    R.flowCurve = {
      off: flowOff, on: flowLinear, pulledDown: flowPulledDown,
      // margins, not bare inequalities — a 1/255 difference proves nothing
      onIsLighterThanOff: flowOff - flowLinear > 20,
      curveShapesIt: flowLinear - flowPulledDown > 20
    }

    R.failed = !(
      R.linear.halfIsAboutHalf &&
      R.pulledDown.thinnerThanLinear &&
      R.pulledUp.fatterThanLinear &&
      R.endpoints.zeroPressureIsThin && R.endpoints.fullPressureMatches &&
      R.noOvershoot.atOrBelowFull &&
      R.opacityCurve.lighter &&
      R.flowCurve.onIsLighterThanOff && R.flowCurve.curveShapesIt
    )
    return R
  })()`)

  console.log('CURVES ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
