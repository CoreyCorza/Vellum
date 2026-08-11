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
  const stroke = (pts, press) => {
    const mk = (p, i) => ({
      x: p[0], y: p[1], tilt: 0, twist: 0, t: i * 16,
      pressure: press ? press(i / (pts.length - 1)) : 1
    })
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

  // 3. pressure tapers at small sizes. A dab thinner than a pixel cannot get
  // thinner, so below the floor it has to fade instead — otherwise every one of
  // these draws a uniform solid line and pressure looks broken.
  const taper = (y, size) => {
    ed.setBrush({
      size: size, hardness: 1, spacing: 0.05, opacity: 1, flow: 1,
      pressureToSize: true, pressureToOpacity: false, pressureToFlow: false,
      sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
      minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
      symmetry: 'none', color: '#111111'
    })
    const pts = []
    for (let i = 0; i <= 200; i++) pts.push([1460 + i * 2.3, y])
    stroke(pts, (t) => 0.02 + t * 0.98)
  }
  taper(200, 1)
  taper(250, 2)
  taper(310, 4)
  taper(390, 12)

  // 4. a cursive 'eeee' at low flow — a chain of acute self-crossings. This is
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

  // Ink along the size-1 taper, to confirm pressure actually moves it. The layer
  // is opaque white, so this reads LUMINANCE -- 255 is bare paper, 0 is full
  // black. Alpha would be 255 everywhere and say nothing.
  const lum = (x, y) => ed.doc.active.surface.ctx.getImageData(x, y, 1, 1).data[0]
  const taperInk = [0.05, 0.3, 0.6, 0.95].map((t) => {
    const x = Math.round(1460 + t * 200 * 2.3)
    let darkest = 255
    for (let y = 197; y <= 203; y++) darkest = Math.min(darkest, lum(x, y))
    return { pressure: +(0.02 + t * 0.98).toFixed(2), darkest }
  })

  return { doc: [ed.doc.width, ed.doc.height], taperInk }
})()`

/** The viewport, zoomed out. This is a different question from the sheet above:
 *  not "is the dab right" but "does drawing the document smaller than 1:1 keep
 *  the image, or just sample it". */
const ZOOM = (scale, cx, cy) => `(() => {
  const ed = window.editor
  ed.camera.scale = ${scale}
  ed.camera.cx = ${cx === undefined ? 'ed.doc.width / 2' : cx}
  ed.camera.cy = ${cy === undefined ? 'ed.doc.height / 2' : cy}
  ed.camera.rotation = 0
  ed.invalidate()
  return true
})()`

/** The same crop magnified 3x under each available filter, which is the whole
 *  question at high zoom: Chrome's 'high' is a soft multi-tap and reads as
 *  blurry on ink, 'low' is bilinear, and nearest is crisp but blocky. */
const GRAB_ZOOMIN = `(() => {
  const s = window.editor.doc.active.surface
  const SX = 806, SY = 676, SW = 62, SH = 46, Z = 3
  const c = document.createElement('canvas')
  c.width = SW * Z * 3 + 40; c.height = SH * Z + 30
  const g = c.getContext('2d')
  g.fillStyle = '#f2ece0'; g.fillRect(0, 0, c.width, c.height)
  const panel = (i, smooth, quality) => {
    g.save()
    g.imageSmoothingEnabled = smooth
    if (quality) g.imageSmoothingQuality = quality
    g.drawImage(s.canvas, SX, SY, SW, SH, i * (SW * Z + 20), 30, SW * Z, SH * Z)
    g.restore()
  }
  panel(0, true, 'high')
  panel(1, true, 'low')
  panel(2, false)
  g.fillStyle = '#111'; g.font = '13px sans-serif'
  g.fillText('high', 8, 20)
  g.fillText('low / bilinear', SW * Z + 28, 20)
  g.fillText('nearest', 2 * (SW * Z + 20) + 8, 20)
  return c.toDataURL('image/png')
})()`

const GRAB_VIEW = `(() => {
  const v = document.getElementById('view')
  const c = document.createElement('canvas')
  c.width = v.width; c.height = v.height
  c.getContext('2d').drawImage(v, 0, 0)
  return c.toDataURL('image/png')
})()`

/** A 1:1 crop of the real viewport, so what is judged is actual screen pixels
 *  and not a screenshot that some other tool has already resampled. */
const GRAB_VIEW_CROP = `(() => {
  const v = document.getElementById('view')
  const c = document.createElement('canvas')
  c.width = 640; c.height = 400
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = false
  g.drawImage(v, Math.round(v.width / 2 - 320), Math.round(v.height / 2 - 200), 640, 400, 0, 0, 640, 400)
  return c.toDataURL('image/png')
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
  // the faint end of the size-1 pressure taper
  g.drawImage(s.canvas, 1500, 186, 120, 28, 1240, 1130, 720, 168)
  g.strokeStyle = '#e8564f'; g.lineWidth = 2
  g.strokeRect(1, 1131, 598, 166)
  g.strokeRect(701, 1131, 238, 166)
  g.strokeRect(961, 1131, 238, 166)
  g.strokeRect(1241, 1131, 718, 166)
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

  const sheet = await win.webContents.executeJavaScript(GRAB)
  await fs.writeFile(out, Buffer.from(sheet.split(',')[1], 'base64'))

  // The viewport at 20%: a separate file, because it answers a separate question.
  await win.webContents.executeJavaScript(ZOOM(0.2))
  await new Promise((r) => setTimeout(r, 400))
  const view = await win.webContents.executeJavaScript(GRAB_VIEW)
  const viewOut = out.replace(/\.png$/, '-zoom.png')
  await fs.writeFile(viewOut, Buffer.from(view.split(',')[1], 'base64'))

  // The real viewport at 307%, cropped 1:1 -- the case reported as blurry.
  // Two places, because a hard edge and a soft edge fail differently.
  for (const [name, cx, cy] of [['hard', 850, 800], ['soft', 1650, 780]]) {
    await win.webContents.executeJavaScript(ZOOM(3.07, cx, cy))
    await new Promise((r) => setTimeout(r, 350))
    const vin = await win.webContents.executeJavaScript(GRAB_VIEW_CROP)
    await fs.writeFile(out.replace(/\.png$/, `-307-${name}.png`), Buffer.from(vin.split(',')[1], 'base64'))
  }

  const zin = await win.webContents.executeJavaScript(GRAB_ZOOMIN)
  const zinOut = out.replace(/\.png$/, '-zoomin.png')
  await fs.writeFile(zinOut, Buffer.from(zin.split(',')[1], 'base64'))

  process.stdout.write('RENDERED ' + JSON.stringify({ out, viewOut, zinOut, info }) + '\n')
  app.exit(0)
})
