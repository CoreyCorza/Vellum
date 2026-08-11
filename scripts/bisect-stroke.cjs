/** Minimal single-stroke smoke test, with per-phase timing, to isolate the stall. */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 700, show: true,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const ed = window.editor
    const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    const marks = []
    const mark = (label) => marks.push({ label, t: +performance.now().toFixed(1) })

    mark('start')
    ed.camera.scale = 1
    ed.setBrush({
      size: 60, hardness: 0.5, spacing: 0.06, opacity: 0.5, flow: 1,
      pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
      sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
      minSize: 0, stabilise: 0, symmetry: 'none', color: '#000000'
    })
    mark('setBrush')
    ed.doc.active.surface.clear()
    ed.history.clear()
    mark('clear')

    const n = 60
    const sp = (i) => ({ x: 500 + i * 10, y: 700, pressure: 1, tilt: 0, twist: 0, t: i * 5 })
    ed.beginStroke(sp(0), false)
    mark('beginStroke')
    for (let i = 1; i <= n; i++) ed.extendStroke(sp(i))
    mark('extend x60')
    ed.endStroke()
    mark('endStroke')

    const a = ed.doc.active.surface.ctx.getImageData(800, 700, 1, 1).data[3]
    mark('readback')

    // The reported case: one stroke scribbling back over itself at 50% opacity.
    ed.doc.active.surface.clear()
    ed.history.clear()
    const pts = []
    for (let row = 0; row < 10; row++) {
      const y = 500 + row * 30
      for (let i = 0; i <= 30; i++) {
        const t = row % 2 === 0 ? i / 30 : 1 - i / 30
        pts.push({ x: 700 + t * 400, y })
      }
    }
    mark('scribble built')
    const sp2 = (i) => ({ x: pts[i].x, y: pts[i].y, pressure: 1, tilt: 0, twist: 0, t: i * 5 })
    ed.beginStroke(sp2(0), false)
    for (let i = 1; i < pts.length; i++) ed.extendStroke(sp2(i))
    mark('scribble extended')
    ed.endStroke()
    mark('scribble committed')
    const d = ed.doc.active.surface.ctx.getImageData(900, 640, 1, 1).data[3]
    mark('scribble readback')

    // soft-edge check: ramp width across the top edge of the scribble block
    const col = ed.doc.active.surface.ctx.getImageData(900, 0, 1, ed.doc.height).data
    let lo = -1, hi = -1
    for (let y = 400; y < 520; y++) {
      const av = col[y * 4 + 3]
      if (lo < 0 && av >= 26) lo = y
      if (av >= 230) { hi = y; break }
    }
    mark('edge readback')

    return {
      alphaAtCentre: a,
      scribbleAlpha: d,
      edgeRampRows: lo >= 0 && hi >= 0 ? hi - lo : -1,
      dabCount: pts.length,
      marks
    }
  })()`)

  console.log('BISECT ' + JSON.stringify(result, null, 2))
  app.exit(0)
})
