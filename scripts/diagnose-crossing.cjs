/**
 * Why is a self-intersection LIGHTER than the stroke around it?
 *
 * Reported at flow 6%, opacity 100%, hardness 0% — and at every other setting
 * combination too. Both accumulation channels only ever increase where a stroke
 * overlaps itself, so a paler crossing should be impossible. That means a bug,
 * not a formula choice.
 *
 * Dumps coverage (red), ceiling (alpha) and the committed result along a line
 * through a crossing, at the user's exact settings.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')
dialog.showErrorBox = (t, c) => {
  process.stdout.write(`FATAL ${t}: ${c}\n`)
  app.exit(1)
}
process.on('uncaughtException', (e) => {
  process.stdout.write(`FATAL ${e && e.stack ? e.stack : e}\n`)
  app.exit(1)
})
setTimeout(() => {
  process.stdout.write('FATAL watchdog\n')
  app.exit(1)
}, 60000)

const SCRIPT = `(() => {
  const ed = window.editor
  if (!ed) return { failed: true, reason: 'no editor' }
  ed.camera.scale = 1
  ed.camera.rotation = 0
  ed.camera.cx = ed.doc.width / 2
  ed.camera.cy = ed.doc.height / 2

  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  // The reported configuration, exactly.
  ed.setBrush({
    size: 80, hardness: 0, spacing: 0.06, opacity: 1, flow: 0.06,
    pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
    sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
    minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
    symmetry: 'none', color: '#000000'
  })
  ed.doc.active.surface.clear()
  ed.history.clear()

  // One stroke: horizontal through y=700, then vertical through x=1000.
  const pts = []
  for (let i = 0; i <= 60; i++) pts.push({ x: 700 + i * 10, y: 700, pressure: 1, tilt: 0, twist: 0, t: 0 })
  for (let i = 0; i <= 50; i++) pts.push({ x: 1000, y: 450 + i * 10, pressure: 1, tilt: 0, twist: 0, t: 0 })

  ed.beginStroke(pts[0], false)
  for (let i = 1; i < pts.length; i++) ed.extendStroke(pts[i])

  // Sample the ACCUMULATION before committing.
  const accumRow = []
  for (let x = 940; x <= 1060; x += 10) {
    const s = ed.debugAccum(x, 700)
    accumRow.push({ x: x, coverage: s.r, ceiling: s.a })
  }

  ed.endStroke()

  // Committed alpha along the same row.
  const layer = ed.doc.active.surface.ctx.getImageData(900, 700, 220, 1).data
  const finalRow = []
  for (let i = 0; i <= 120; i += 10) {
    finalRow.push({ x: 900 + i + 40, alpha: layer[(i + 40) * 4 + 3] })
  }

  return {
    // away from the crossing (single pass) vs at it
    singlePass: { accum: accumRow[0], },
    accumAcrossCrossing: accumRow,
    committedAcrossCrossing: finalRow
  }
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
  win.webContents.on('console-message', (_e, level, m) => {
    if (level >= 3) errors.push(m)
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  let result
  try {
    result = await win.webContents.executeJavaScript(SCRIPT)
  } catch (err) {
    result = { threw: String(err && err.message ? err.message : err) }
  }
  result.consoleErrors = errors
  process.stdout.write('CROSSING ' + JSON.stringify(result, null, 2) + '\n')
  app.exit(0)
})
