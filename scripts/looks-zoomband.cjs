/**
 * The zoom band, one strip per step, so the crossfade can be checked for a snap.
 *
 * The failure this guards against is a zoom at which the canvas visibly changes
 * character — crisp one notch, hazy the next. That is what Photoshop and Krita
 * do around 200%, and it is the part people notice. Read the strip left to right:
 * the change should be gradual and no single step should stand out.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const root = path.join(__dirname, '..')
const out = process.argv[2] || path.join(root, 'zoomband.png')
const STEPS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.07]

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 120000)

const DRAW = `(() => {
  const ed = window.editor
  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  ed.camera.rotation = 0
  ed.doc.active.surface.clear()
  ed.doc.active.surface.fill('#f2ece0')
  ed.history.clear()
  // Hardness 100: an edge the filter can actually be judged on. A soft brush
  // is soft at every zoom and says nothing about the viewport.
  ed.setBrush({
    size: 9, hardness: 1, spacing: 0.06, opacity: 1, flow: 1,
    pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
    sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
    minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
    symmetry: 'none', color: '#1b1f24'
  })
  const pts = []
  for (let i = 0; i <= 300; i++) {
    const t = i / 300
    pts.push({ x: 760 + t * 120, y: 640 + t * 160 + Math.sin(t * 9) * 26, pressure: 1, tilt: 0, twist: 0, t: i * 16 })
  }
  ed.beginStroke(pts[0], false)
  for (let i = 1; i < pts.length; i++) ed.extendStroke(pts[i])
  ed.endStroke()
  return true
})()`

const AT = (scale) => `(() => {
  const ed = window.editor
  ed.camera.scale = ${scale}
  ed.camera.cx = 800
  ed.camera.cy = 700
  ed.invalidate()
  return true
})()`

/** A fixed DOCUMENT-space window, so every strip shows the same ink and only
 *  the filtering differs. Sampled at the zoom's own screen size then normalised
 *  back, which is what makes the strips comparable. */
const CROP = (scale) => `(() => {
  const v = document.getElementById('view')
  const w = Math.round(46 * ${scale}), h = Math.round(150 * ${scale})
  const c = document.createElement('canvas')
  c.width = 46 * 3; c.height = 150 * 3
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(v, Math.round(v.width / 2 - w / 2), Math.round(v.height / 2 - h / 2), w, h, 0, 0, 46 * 3, 150 * 3)
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
  await win.webContents.executeJavaScript(DRAW)

  const strips = []
  for (const s of STEPS) {
    await win.webContents.executeJavaScript(AT(s))
    await new Promise((r) => setTimeout(r, 320))
    strips.push(await win.webContents.executeJavaScript(CROP(s)))
  }

  const W = 46 * 3, H = 150 * 3
  const sheet = await win.webContents.executeJavaScript(`(() => {
    const urls = ${JSON.stringify(strips)}
    const labels = ${JSON.stringify(STEPS.map((s) => Math.round(s * 100) + '%'))}
    const c = document.createElement('canvas')
    c.width = (${W} + 12) * urls.length; c.height = ${H} + 28
    const g = c.getContext('2d')
    g.fillStyle = '#f2ece0'; g.fillRect(0, 0, c.width, c.height)
    return Promise.all(urls.map((u) => new Promise((res) => {
      const im = new Image(); im.onload = () => res(im); im.src = u
    }))).then((ims) => {
      ims.forEach((im, i) => g.drawImage(im, i * (${W} + 12), 24))
      g.fillStyle = '#111'; g.font = '13px sans-serif'
      labels.forEach((l, i) => g.fillText(l, i * (${W} + 12) + 4, 16))
      return c.toDataURL('image/png')
    })
  })()`)

  await fs.writeFile(out, Buffer.from(sheet.split(',')[1], 'base64'))
  process.stdout.write('RENDERED ' + JSON.stringify({ out, steps: STEPS }) + '\n')
  app.exit(0)
})
