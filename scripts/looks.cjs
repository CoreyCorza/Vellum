/**
 * The visual suite. `npm run looks` renders a fixed sheet of brush cases to a
 * PNG so they can be LOOKED at.
 *
 * This exists because the numeric suites cannot see a shape. A faceted rim, a
 * dashed thin line, a banded falloff — every one of those passed the numbers.
 * Anything that touches the dab mask, the spacing walk, or the compositor gets
 * run through here and eyeballed before it is called done.
 *
 * Panels, top to bottom:
 *   1. Large capsules at hardness 1.0 / 0.6 / 0.0 — the rim at a radius well
 *      past any sprite resolution.
 *   2. Thin diagonals at size 1 / 2 / 3 / 6 — sub-pixel dab coverage, and
 *      whether the spacing walk leaves gaps.
 *   3. A cursive 'eeee' at low flow — self-crossings, the case that exposed the
 *      compositor being wrong.
 *   4. The rim and the 1px line again at 6x, where the pixels show.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const root = path.join(__dirname, '..')
const out = process.argv[2] || path.join(root, 'looks.png')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 90000)

const SCRIPT = `(() => {
  const ed = window.editor
  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  ed.camera.scale = 1
  ed.camera.rotation = 0
  ed.doc.active.surface.clear()
  ed.doc.active.surface.fill('#ffffff')
  ed.history.clear()

  const brush = (size, hardness) => ed.setBrush({
    size: size, hardness: hardness, spacing: 0.05, opacity: 1, flow: 1,
    pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
    sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
    minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
    symmetry: 'none', color: '#111111'
  })
  const stroke = (pts) => {
    const mk = (p, i) => ({ x: p[0], y: p[1], pressure: 1, tilt: 0, twist: 0, t: i * 16 })
    ed.beginStroke(mk(pts[0], 0), false)
    for (let i = 1; i < pts.length; i++) ed.extendStroke(mk(pts[i], i))
    ed.endStroke()
  }

  // 1. big capsules — rim quality
  const cap = (cx, cy, size, hardness) => {
    brush(size, hardness)
    stroke([[cx - 40, cy], [cx + 40, cy]])
  }
  cap(300, 340, 340, 1.0)
  cap(760, 340, 340, 0.6)
  cap(1220, 340, 340, 0.0)

  // 2. thin diagonals — sub-pixel coverage and spacing gaps. Near-vertical but
  // not vertical, which is where a sub-pixel dab misses pixel centres.
  const diag = (x0, size) => {
    brush(size, 1.0)
    stroke([[x0, 620], [x0 + 34, 900], [x0 + 52, 1180]])
  }
  diag(220, 1)
  diag(420, 2)
  diag(620, 3)
  diag(820, 6)

  // 3. a cursive 'eeee' at low flow — a chain of acute self-crossings. This is
  // the case that exposed the compositor being wrong: overlaps must not bloom
  // into dark knots or grow a hard edge where the soft rims cross.
  brush(70, 0)
  ed.setBrush({ flow: 0.06 })
  const loop = []
  for (let i = 0; i <= 900; i++) {
    const t = (i / 900) * Math.PI * 6
    loop.push([1450 + (i / 900) * 460 + Math.sin(t) * 70, 780 + Math.cos(t) * 150])
  }
  stroke(loop)

  return { doc: [ed.doc.width, ed.doc.height] }
})()`

const GRAB = `(() => {
  const s = window.editor.doc.active.surface
  const c = document.createElement('canvas')
  c.width = 1960; c.height = 1300
  const g = c.getContext('2d')
  g.fillStyle = '#909090'; g.fillRect(0, 0, c.width, c.height)

  // 1:1 of everything
  g.drawImage(s.canvas, 60, 120, 1900, 1120, 0, 0, 1900, 1120)

  // 6x: hard capsule top rim, and the size-1 diagonal
  g.imageSmoothingEnabled = false
  g.drawImage(s.canvas, 210, 158, 100, 28, 0, 1130, 600, 168)
  g.drawImage(s.canvas, 228, 700, 40, 28, 700, 1130, 240, 168)
  g.drawImage(s.canvas, 432, 700, 40, 28, 960, 1130, 240, 168)
  g.strokeStyle = '#e8564f'; g.lineWidth = 2
  g.strokeRect(1, 1131, 598, 166)
  g.strokeRect(701, 1131, 238, 166)
  g.strokeRect(961, 1131, 238, 166)
  return c.toDataURL('image/png')
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: true,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))
  const info = await win.webContents.executeJavaScript(SCRIPT)
  const dataUrl = await win.webContents.executeJavaScript(GRAB)
  await fs.writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
  process.stdout.write('RENDERED ' + JSON.stringify({ out, info }) + '\n')
  app.exit(0)
})
