/**
 * Renders brush edges large enough to judge, then again at 6x nearest-neighbour
 * magnification, so the rim can be LOOKED at.
 *
 * The point of this script: a numeric suite cannot see a faceted or banded
 * edge. Every engine change that touches the dab mask should be run through
 * here and eyeballed before it is called done.
 *
 * Three capsules, hardness 1.0 / 0.6 / 0.0, at a radius far larger than the
 * old 128px tip sprite — which is exactly where sprite magnification showed.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const root = path.join(__dirname, '..')
const out = process.argv[2] || path.join(root, 'aa.png')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 60000)

const SCRIPT = `(() => {
  const ed = window.editor
  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  ed.camera.scale = 1
  ed.camera.rotation = 0
  ed.doc.active.surface.clear()
  ed.doc.active.surface.fill('#ffffff')
  ed.history.clear()

  const capsule = (cx, cy, size, hardness) => {
    ed.setBrush({
      size: size, hardness: hardness, spacing: 0.05, opacity: 1, flow: 1,
      pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
      sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
      minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
      symmetry: 'none', color: '#111111'
    })
    const pt = (x, t) => ({ x: x, y: cy, pressure: 1, tilt: 0, twist: 0, t: t })
    ed.beginStroke(pt(cx - 40, 0), false)
    ed.extendStroke(pt(cx + 40, 16))
    ed.endStroke()
  }

  capsule(300, 340, 340, 1.0)
  capsule(760, 340, 340, 0.6)
  capsule(1220, 340, 340, 0.0)

  // A small brush too: AA has to hold at radius ~3 as well as radius 170.
  capsule(300, 640, 6, 1.0)
  capsule(360, 640, 12, 1.0)
  capsule(440, 640, 24, 1.0)

  return { doc: [ed.doc.width, ed.doc.height] }
})()`

/** Two panels: the dabs at 1:1, and a 6x nearest-neighbour blowup of the
 *  hard capsule's left cap where sprite faceting was visible. */
const GRAB = `(() => {
  const s = window.editor.doc.active.surface
  const W = 1500, H = 700
  const c = document.createElement('canvas')
  c.width = W; c.height = H + 400
  const g = c.getContext('2d')
  g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height)
  g.drawImage(s.canvas, 60, 120, W, H, 0, 0, W, H)

  // 6x zoom on the rim of the hard capsule: left cap edge (x~90) and top edge
  // (y~170). Left cap centre is (260,340), radius 170.
  g.imageSmoothingEnabled = false
  g.drawImage(s.canvas, 78, 306, 100, 66, 0, H, 600, 396)
  g.drawImage(s.canvas, 210, 158, 100, 66, 620, H, 600, 396)
  g.strokeStyle = '#e8564f'; g.lineWidth = 2
  g.strokeRect(1, H + 1, 598, 394); g.strokeRect(621, H + 1, 598, 394)
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
