/**
 * Renders a looping, self-crossing stroke at the reported settings and writes it
 * to a PNG, so the artifact can be LOOKED at rather than sampled. Point samples
 * said the crossings get darker; the screenshots plainly show them lighter, so
 * one of the two is measuring the wrong thing.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const root = path.join(__dirname, '..')
const out = process.argv[2] || path.join(root, 'loops.png')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 60000)

const SCRIPT = `(() => {
  const ed = window.editor
  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  ed.camera.scale = 1
  ed.camera.rotation = 0
  ed.setBrush({
    size: 70, hardness: 0, spacing: 0.06, opacity: 1, flow: 0.06,
    pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
    sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
    minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
    symmetry: 'none', color: '#e8564f'
  })
  ed.doc.active.surface.clear()
  ed.doc.active.surface.fill('#f2ece0')
  ed.history.clear()

  // A cursive 'eeee' — a chain of loops, each crossing itself acutely, which is
  // the shape the artifact appears on.
  const pts = []
  const N = 1400
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 8
    const x = 380 + (i / N) * 1200 + Math.sin(t) * 120
    const y = 700 + Math.cos(t) * 190 + Math.sin(t * 0.5) * 40
    pts.push({ x: x, y: y, pressure: 1, tilt: 0, twist: 0, t: i * 4 })
  }
  ed.beginStroke(pts[0], false)
  for (let i = 1; i < pts.length; i++) ed.extendStroke(pts[i])
  ed.endStroke()
  return { dabs: pts.length }
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

  const dataUrl = await win.webContents.executeJavaScript(
    `(() => {
       const s = window.editor.doc.active.surface
       const c = document.createElement('canvas')
       c.width = 1100; c.height = 620
       c.getContext('2d').drawImage(s.canvas, 300, 400, 1100, 620, 0, 0, 1100, 620)
       return c.toDataURL('image/png')
     })()`
  )
  await fs.writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
  process.stdout.write('RENDERED ' + JSON.stringify({ out, info }) + '\n')
  app.exit(0)
})
