/**
 * Asserts that a hard brush still antialiases.
 *
 * The defect this exists for: at hardness 100% the rim had a one-pixel ramp
 * shaped by smoothstep, so on some edge angles one pixel sampled full coverage
 * and its neighbour sampled none — a solid pixel touching an empty one with no
 * transition between. Visible as a jagged, chewed edge at high zoom, and no
 * other suite could see it: total ink, ramp widths and centre samples were all
 * unchanged.
 *
 * Stated as a property instead: on a curved hard edge, a FULLY OPAQUE pixel must
 * never be 4-adjacent to a FULLY TRANSPARENT one. Every real paint application
 * satisfies this; it is what "antialiased" means at the pixel level.
 *
 * Drawn on a cleared layer so the alpha channel is the coverage. Circles, not
 * straight lines, so every edge angle is sampled at once.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 90000)

const SCRIPT = `(() => {
  const ed = window.editor
  const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  ed.camera.scale = 1
  ed.camera.rotation = 0
  ed.history.clear()

  const measure = (size) => {
    ed.doc.active.surface.clear()
    ed.setBrush({
      size: size, hardness: 1, spacing: 0.05, opacity: 1, flow: 1,
      pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
      sizeCurve: lin, opacityCurve: lin, flowCurve: lin,
      minSize: 0, stabilise: 0, stabiliseSpeedAdapt: 0, pathSmoothness: 1,
      symmetry: 'none', color: '#000000'
    })
    // A ring, so the edge passes through every orientation.
    const pts = []
    for (let i = 0; i <= 720; i++) {
      const a = (i / 720) * Math.PI * 2
      pts.push({ x: 500 + Math.cos(a) * 220, y: 500 + Math.sin(a) * 220, pressure: 1, tilt: 0, twist: 0, t: i * 16 })
    }
    ed.beginStroke(pts[0], false)
    for (let i = 1; i < pts.length; i++) ed.extendStroke(pts[i])
    ed.endStroke()

    const g = ed.doc.active.surface.ctx
    const { data, width, height } = g.getImageData(200, 200, 600, 600)
    const A = (x, y) => data[(y * width + x) * 4 + 3]

    let hardPairs = 0
    let mid = 0
    let opaque = 0
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const a = A(x, y)
        if (a >= 250) {
          opaque++
          if (A(x + 1, y) <= 5 || A(x - 1, y) <= 5 || A(x, y + 1) <= 5 || A(x, y - 1) <= 5) hardPairs++
        } else if (a > 5) mid++
      }
    }
    return { size, hardPairs, midtonePixels: mid, opaquePixels: opaque }
  }

  const rows = [measure(2), measure(9), measure(40)]
  return {
    rows,
    // The property: no solid pixel anywhere touching an empty one.
    noHardTransitions: rows.every((r) => r.hardPairs === 0),
    // And the ramp has to actually exist, not just be non-adjacent.
    hasRamp: rows.every((r) => r.midtonePixels > r.opaquePixels * 0.02)
  }
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))
  const R = await win.webContents.executeJavaScript(SCRIPT)
  R.failed = !(R.noHardTransitions && R.hasRamp)
  process.stdout.write('EDGE ' + JSON.stringify(R, null, 2) + '\n')
  app.exit(R.failed ? 1 : 0)
})
