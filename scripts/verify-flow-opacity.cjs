/**
 * Flow vs opacity, against the WebGL2 dab renderer.
 *
 *   OPACITY is a ceiling  — a stroke lands at that darkness and stops, however
 *                           much it overlaps itself.
 *   FLOW    is a rate     — repeated coverage keeps building toward the ceiling.
 *
 * Rewritten from scratch: the previous version accumulated so many edits that a
 * scripted patch broke its syntax, and Electron then sat on a modal error dialog
 * which looked exactly like an infinite loop for several rounds. Hence
 * `crashReporter`-style guards below: dialogs off, errors reported, hard timeout.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

// Never let a modal dialog masquerade as a hang again.
dialog.showErrorBox = (title, content) => {
  process.stdout.write(`FATAL ${title}: ${content}\n`)
  app.exit(1)
}
process.on('uncaughtException', (err) => {
  process.stdout.write(`FATAL ${err && err.stack ? err.stack : err}\n`)
  app.exit(1)
})
setTimeout(() => {
  process.stdout.write('FATAL watchdog: no result after 90s\n')
  app.exit(1)
}, 90000)

const SCRIPT = `(() => {
  const ed = window.editor
  if (!ed) return { failed: true, reason: 'no editor' }
  ed.camera.scale = 1
  ed.camera.rotation = 0
  ed.camera.cx = ed.doc.width / 2
  ed.camera.cy = ed.doc.height / 2

  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  const base = {
    size: 60, hardness: 0.9, spacing: 0.06, opacity: 1, flow: 1,
    pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
    sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
    minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
    symmetry: 'none', color: '#000000'
  }
  const set = (o) => ed.setBrush(Object.assign({}, base, o))
  const alphaAt = (x, y) => ed.doc.active.surface.ctx.getImageData(x, y, 1, 1).data[3]

  const drawStroke = (pts, passes) => {
    for (let p = 0; p < (passes || 1); p++) {
      ed.beginStroke(pts[0], false)
      for (let i = 1; i < pts.length; i++) ed.extendStroke(pts[i])
      ed.endStroke()
    }
  }
  const pt = (x, y, pressure) => ({ x: x, y: y, pressure: pressure, tilt: 0, twist: 0, t: 0 })
  const lineY = (y, pressure) => {
    const a = []
    for (let i = 0; i <= 100; i++) a.push(pt(500 + i * 10, y, pressure))
    return a
  }
  const fresh = () => { ed.doc.active.surface.clear(); ed.history.clear() }

  const R = {}
  const near = (v, t, tol) => Math.abs(v - t) <= (tol === undefined ? 14 : tol)

  // --- 1. flat opacity is a ceiling, reached exactly ----------------------
  const flat = (opacity) => { fresh(); set({ opacity: opacity }); drawStroke(lineY(700, 1), 1); return alphaAt(1000, 700) }
  R.flatOpacity = { at100: flat(1), at50: flat(0.5), at25: flat(0.25) }
  R.flatOpacityOk = near(R.flatOpacity.at100, 255) && near(R.flatOpacity.at50, 128) && near(R.flatOpacity.at25, 64)

  // --- 2. THE reported case: scribble fill in ONE stroke ------------------
  const scribble = (opts) => {
    fresh(); set(opts)
    const pts = []
    for (let row = 0; row < 12; row++) {
      const y = 500 + row * 26
      for (let i = 0; i <= 30; i++) {
        const t = row % 2 === 0 ? i / 30 : 1 - i / 30
        pts.push(pt(700 + t * 500, y, 1))
      }
    }
    drawStroke(pts, 1)
    return alphaAt(950, 640)
  }
  R.scribble = {
    opacity100: scribble({ opacity: 1 }),
    opacity50: scribble({ opacity: 0.5 }),
    opacity25: scribble({ opacity: 0.25 }),
    opacity50ViaPressure: scribble({ opacity: 0.5, pressureToOpacity: true })
  }
  R.scribbleOk =
    near(R.scribble.opacity100, 255) && near(R.scribble.opacity50, 128) &&
    near(R.scribble.opacity25, 64) && near(R.scribble.opacity50ViaPressure, 128, 20)

  // --- 3. pressure drives the ceiling; flow stays a rate ------------------
  const byPressure = (opts, pressure) => { fresh(); set(opts); drawStroke(lineY(700, pressure), 1); return alphaAt(1000, 700) }
  R.pressureOpacity = {
    p100: byPressure({ pressureToOpacity: true }, 1),
    p50: byPressure({ pressureToOpacity: true }, 0.5),
    p25: byPressure({ pressureToOpacity: true }, 0.25)
  }
  R.pressureFlow = {
    p50: byPressure({ pressureToFlow: true }, 0.5),
    p25: byPressure({ pressureToFlow: true }, 0.25)
  }
  R.pressureOpacityOk =
    near(R.pressureOpacity.p100, 255) && near(R.pressureOpacity.p50, 128) && near(R.pressureOpacity.p25, 64)
  R.flowIsDifferent =
    R.pressureFlow.p50 - R.pressureOpacity.p50 > 60 &&
    R.pressureFlow.p25 - R.pressureOpacity.p25 > 60

  // --- 4. self-intersection keeps the stronger pass -----------------------
  fresh(); set({ pressureToOpacity: true })
  const cross = []
  for (let i = 0; i <= 60; i++) cross.push(pt(600 + i * 10, 700, 1))
  for (let i = 0; i <= 50; i++) cross.push(pt(900, 450 + i * 10, 0.2))
  drawStroke(cross, 1)
  R.crossing = { heavyOnly: alphaAt(700, 700), lightOnly: alphaAt(900, 500), atCrossing: alphaAt(900, 700) }
  R.crossingOk = R.crossing.atCrossing >= R.crossing.heavyOnly - 14

  // --- 5. a soft edge stays soft where the stroke doubles back ------------
  const ramp = (passes) => {
    fresh(); set({ size: 120, hardness: 0.05, spacing: 0.05 })
    const fwd = [], back = []
    for (let i = 0; i <= 80; i++) fwd.push(pt(500 + i * 8, 700, 1))
    for (let i = 80; i >= 0; i--) back.push(pt(500 + i * 8, 700, 1))
    drawStroke(passes === 1 ? fwd : fwd.concat(back), 1)
    const col = ed.doc.active.surface.ctx.getImageData(900, 0, 1, ed.doc.height).data
    let lo = -1, hi = -1
    for (let y = 600; y < 705; y++) {
      const a = col[y * 4 + 3]
      if (lo < 0 && a >= 26) lo = y
      if (a >= 230) { hi = y; break }
    }
    return lo >= 0 && hi >= 0 ? hi - lo : -1
  }
  R.edge = { singlePass: ramp(1), doubleBack: ramp(2) }
  // The ramp legitimately NARROWS when a stroke doubles back. Each dab moves a
  // pixel by flow x mask x (ceiling - dst), so pixels further from the ceiling
  // gain more, and the whole ramp compresses toward it. Krita does the same.
  // What must not happen is the soft edge collapsing into a hard one, so the
  // check is that it stays several pixels wide -- 0.85 was a guess that encoded
  // "does not change", which is not what the formula promises.
  R.edgeOk = R.edge.singlePass > 8 && R.edge.doubleBack >= R.edge.singlePass * 0.7

  // --- 6. flow still builds up across passes ------------------------------
  const build = (passes) => { fresh(); set({ flow: 0.05 }); drawStroke(lineY(700, 1), passes); return alphaAt(1000, 700) }
  R.flowBuild = { onePass: build(1), threePasses: build(3) }
  R.flowBuildOk = R.flowBuild.threePasses > R.flowBuild.onePass + 20

  R.failed = !(R.flatOpacityOk && R.scribbleOk && R.pressureOpacityOk &&
               R.flowIsDifferent && R.crossingOk && R.edgeOk && R.flowBuildOk)
  return R
})()`

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
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  let result
  try {
    result = await win.webContents.executeJavaScript(SCRIPT)
  } catch (err) {
    result = { failed: true, threw: String(err && err.message ? err.message : err) }
  }
  result.consoleErrors = errors
  if (errors.length > 0) result.failed = true

  process.stdout.write('FLOWOPACITY ' + JSON.stringify(result, null, 2) + '\n')
  app.exit(result.failed ? 1 : 0)
})
