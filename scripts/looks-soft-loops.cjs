/**
 * One-off: the reported case. Soft brush (hardness 0), flow 55%, opacity 100%,
 * cursive loops that cross themselves and enclose small areas.
 *
 * Two things must be true at once and they pull against each other: the enclosed
 * areas have to FILL IN (overlapping passes building on each other), and the
 * crossings must not bloom into a dark knot. Rendered at three flows because the
 * failure looks different at each.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const root = path.join(__dirname, '..')
const out = process.argv[2] || path.join(root, 'soft-loops.png')

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

  const run = (cy, flow) => {
    ed.setBrush({
      size: 110, hardness: 0, spacing: 0.01, opacity: 1, flow: flow,
      pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
      sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
      minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
      symmetry: 'none', color: '#1b1f24'
    })
    const pts = []
    for (let i = 0; i <= 1200; i++) {
      const t = (i / 1200) * Math.PI * 8
      pts.push({
        x: 220 + (i / 1200) * 1500 + Math.sin(t) * 130,
        y: cy + Math.cos(t) * 150,
        pressure: 1, tilt: 0, twist: 0, t: i * 8
      })
    }
    ed.beginStroke(pts[0], false)
    for (let i = 1; i < pts.length; i++) ed.extendStroke(pts[i])
    ed.endStroke()
  }
  run(280, 0.55)
  run(700, 0.06)
  run(1120, 1.0)
  return { doc: [ed.doc.width, ed.doc.height] }
})()`

const GRAB = `(() => {
  const s = window.editor.doc.active.surface
  const c = document.createElement('canvas')
  c.width = 1760; c.height = 1320
  const g = c.getContext('2d')
  g.drawImage(s.canvas, 140, 60, 1760, 1320, 0, 0, 1760, 1320)
  g.fillStyle = '#c03020'; g.font = 'bold 22px sans-serif'
  g.fillText('flow 55%', 8, 30)
  g.fillText('flow 6%', 8, 450)
  g.fillText('flow 100%', 8, 870)
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
  const png = await win.webContents.executeJavaScript(GRAB)
  await fs.writeFile(out, Buffer.from(png.split(',')[1], 'base64'))
  process.stdout.write('RENDERED ' + JSON.stringify({ out, info }) + '\n')
  app.exit(0)
})
