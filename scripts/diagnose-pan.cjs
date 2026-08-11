/**
 * Is panning 1:1 with the cursor, on both input paths?
 *
 * A pan of N screen pixels must move the document exactly N screen pixels,
 * at any zoom. Reported as a ratio: 1.0 is correct, 2.0 means the canvas runs
 * twice as far as the hand.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const ed = window.editor
    const cv = document.getElementById('view')
    cv.setPointerCapture = () => {}
    const box = cv.getBoundingClientRect()
    const mods = window.__wintabMods
    const feed = window.__wintabFeed
    const R = {}

    // Ratio of on-screen document movement to cursor movement.
    const measure = (fn, scale) => {
      ed.camera.scale = scale
      ed.camera.rotation = 0
      ed.camera.cx = ed.doc.width / 2
      ed.camera.cy = ed.doc.height / 2
      const before = ed.camera.docToScreen(0, 0)
      fn()
      const after = ed.camera.docToScreen(0, 0)
      return { dx: after.x - before.x, dy: after.y - before.y }
    }

    const DRAG = 100

    // ---- pointer path (mouse), space held ----
    const pointerPan = (scale) => measure(() => {
      mods.space = true
      ed.lastWintabAt = -Infinity
      ed.penSource = 'pointer'
      const ev = (type, x, buttons) => cv.dispatchEvent(new PointerEvent(type, {
        pointerId: 70, pointerType: 'mouse', isPrimary: true, bubbles: true,
        clientX: box.left + x, clientY: box.top + 300, buttons, button: 0
      }))
      ev('pointerdown', 400, 1)
      ev('pointerrawupdate', 400 + DRAG, 1)
      ev('pointerup', 400 + DRAG, 0)
      mods.space = false
    }, scale)

    // ---- wintab path, space held, pen tip down ----
    const wintabPan = (scale) => measure(() => {
      mods.space = true
      ed.penSource = 'wintab'
      const s = (x, buttons) => ({ t: performance.now(), x: box.left + x, y: box.top + 300,
                                   buttons, pressure: 0.5, tilt: 0, twist: 0, inverted: false })
      feed([s(400, 1)])
      feed([s(400 + DRAG, 1)])
      feed([s(400 + DRAG, 0)])
      mods.space = false
      ed.penSource = 'pointer'
      ed.lastWintabAt = -Infinity
    }, scale)

    R.pointer = {}
    R.wintab = {}
    for (const z of [0.5, 1, 2]) {
      const p = pointerPan(z)
      R.pointer['zoom' + z] = { movedScreenPx: +p.dx.toFixed(2), ratio: +(p.dx / DRAG).toFixed(3) }
      const w = wintabPan(z)
      R.wintab['zoom' + z] = { movedScreenPx: +w.dx.toFixed(2), ratio: +(w.dx / DRAG).toFixed(3) }
    }
    // ---- realistic: BOTH pointerrawupdate and pointermove fire -----------
    // The suppression guard assumes rawupdate always arrives first. If the
    // order ever inverts, the same movement is applied twice.
    const bothEvents = (order) => measure(() => {
      mods.space = true
      ed.lastWintabAt = -Infinity
      ed.penSource = 'pointer'
      const mk = (type, x, buttons) => new PointerEvent(type, {
        pointerId: 71, pointerType: 'mouse', isPrimary: true, bubbles: true,
        clientX: box.left + x, clientY: box.top + 300, buttons, button: 0
      })
      cv.dispatchEvent(mk('pointerdown', 400, 1))
      const x = 400 + DRAG
      if (order === 'raw-first') {
        cv.dispatchEvent(mk('pointerrawupdate', x, 1))
        cv.dispatchEvent(mk('pointermove', x, 1))
      } else {
        cv.dispatchEvent(mk('pointermove', x, 1))
        cv.dispatchEvent(mk('pointerrawupdate', x, 1))
      }
      cv.dispatchEvent(mk('pointerup', x, 0))
      mods.space = false
    }, 1)

    R.bothEventsRawFirst = +(bothEvents('raw-first').dx / DRAG).toFixed(3)
    R.bothEventsMoveFirst = +(bothEvents('move-first').dx / DRAG).toFixed(3)

    // ---- realistic: pen drives Wintab AND synthesises mouse events -------
    // This is the Windows-Ink-off configuration: the tablet moves the system
    // cursor, so every Wintab packet is shadowed by a mouse event.
    R.wintabPlusShadowMouse = +(measure(() => {
      mods.space = true
      ed.penSource = 'wintab'
      const s = (x, buttons) => ({ t: performance.now(), x: box.left + x, y: box.top + 300,
                                   buttons, pressure: 0.5, tilt: 0, twist: 0, inverted: false })
      const mk = (type, x, buttons) => new PointerEvent(type, {
        pointerId: 72, pointerType: 'mouse', isPrimary: true, bubbles: true,
        clientX: box.left + x, clientY: box.top + 300, buttons, button: 0
      })
      feed([s(400, 1)]); cv.dispatchEvent(mk('pointerdown', 400, 1))
      feed([s(400 + DRAG, 1)]); cv.dispatchEvent(mk('pointerrawupdate', 400 + DRAG, 1))
      feed([s(400 + DRAG, 0)]); cv.dispatchEvent(mk('pointerup', 400 + DRAG, 0))
      mods.space = false
      ed.penSource = 'pointer'
      ed.lastWintabAt = -Infinity
    }, 1).dx / DRAG).toFixed(3)

    // ---- BOTH paths start a pan concurrently -----------------------------
    // The failure mode: each input layer owning its own NavDrag means each
    // applies the full delta, so the canvas travels twice as far as the hand.
    R.concurrentPanBothPaths = +(measure(() => {
      mods.space = true
      const s = (x, buttons) => ({ t: performance.now(), x: box.left + x, y: box.top + 300,
                                   buttons, pressure: 0.5, tilt: 0, twist: 0, inverted: false })
      const mk = (type, x, buttons) => new PointerEvent(type, {
        pointerId: 73, pointerType: 'mouse', isPrimary: true, bubbles: true,
        clientX: box.left + x, clientY: box.top + 300, buttons, button: 0
      })
      // pointer starts its pan first (no Wintab traffic yet)
      ed.penSource = 'pointer'
      ed.lastWintabAt = -Infinity
      cv.dispatchEvent(mk('pointerdown', 400, 1))
      // ...then the tablet begins reporting and drives the same gesture
      ed.penSource = 'wintab'
      feed([s(400, 1)])
      feed([s(400 + DRAG, 1)])
      cv.dispatchEvent(mk('pointerrawupdate', 400 + DRAG, 1))
      feed([s(400 + DRAG, 0)])
      cv.dispatchEvent(mk('pointerup', 400 + DRAG, 0))
      mods.space = false
      ed.penSource = 'pointer'
      ed.lastWintabAt = -Infinity
    }, 1).dx / DRAG).toFixed(3)

    R.devicePixelRatio = window.devicePixelRatio
    R.failed =
      Object.values({ ...R.pointer, ...R.wintab }).some((v) => Math.abs(v.ratio - 1) > 0.02) ||
      Math.abs(R.bothEventsRawFirst - 1) > 0.02 ||
      Math.abs(R.bothEventsMoveFirst - 1) > 0.02 ||
      Math.abs(R.wintabPlusShadowMouse - 1) > 0.02 ||
      Math.abs(R.concurrentPanBothPaths - 1) > 0.02
    return R
  })()`)

  console.log('PAN ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
