/**
 * Arbitration between the two pen sources.
 *
 * Regression guard for a real bug: with "Use Windows Ink" off, the tablet still
 * drives the system cursor, so Chromium reports the stylus as
 * `pointerType: 'mouse'`. Those events reached the brush at pressure = 1 and
 * interleaved with genuine Wintab samples, producing blotchy strokes that
 * alternated between tapered and full width — and a status badge flickering
 * between "wintab" and "mouse".
 *
 * Suppression is therefore by RECENCY, not pointer type. These checks pin that
 * down, including that a real mouse still works once Wintab goes quiet.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

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
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(String.raw`(async () => {
    const ed = window.editor
    const cv = document.getElementById('view')
    if (!ed || !cv) return { failed: true, reason: 'not mounted' }
    cv.setPointerCapture = () => {}
    const R = {}
    const box = cv.getBoundingClientRect()

    const mouse = (type, x, y, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: 40, pointerType: 'mouse', isPrimary: true, bubbles: true,
      clientX: box.left + x, clientY: box.top + y, buttons, button: 0, pressure: buttons ? 0.5 : 0
    }))

    ed.doc.active.surface.clear()
    ed.history.clear()
    ed.setBrush({ size: 40, hardness: 0.9, opacity: 1, flow: 1, spacing: 0.05,
                  pressureToSize: true, minSize: 0.02, pressureCurve: 1, stabilise: 0,
                  color: '#000000', symmetry: 'none' })

    // ---- baseline: with no Wintab, a mouse must still paint ---------------
    ed.penSource = 'pointer'
    ed.lastWintabAt = -Infinity
    mouse('pointerdown', 300, 300, 1)
    R.mouseWorksWithoutWintab = ed.strokeActive
    mouse('pointerup', 300, 300, 0)

    // ---- with Wintab reporting, a 'mouse' event must be IGNORED -----------
    ed.penSource = 'wintab'
    ed.lastWintabAt = performance.now()      // as if a packet just arrived
    R.wintabRecentTrue = ed.wintabRecent
    mouse('pointerdown', 400, 400, 1)
    R.mouseSuppressedDuringWintab = !ed.strokeActive
    mouse('pointerup', 400, 400, 0)

    // a 'pen' event must be ignored too
    cv.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 41, pointerType: 'pen', isPrimary: true, bubbles: true,
      clientX: box.left + 420, clientY: box.top + 420, buttons: 1, pressure: 0.7
    }))
    R.penSuppressedDuringWintab = !ed.strokeActive
    cv.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 41, pointerType: 'pen', bubbles: true,
      clientX: box.left + 420, clientY: box.top + 420, buttons: 0
    }))

    // ---- once Wintab goes quiet, a real mouse takes over again ------------
    ed.lastWintabAt = performance.now() - 400   // older than the 250ms window
    R.wintabRecentExpires = !ed.wintabRecent
    mouse('pointerdown', 500, 500, 1)
    R.mouseResumesAfterWintabIdle = ed.strokeActive
    mouse('pointerup', 500, 500, 0)

    // ---- telemetry must not flip-flop while Wintab is driving -------------
    ed.lastWintabAt = performance.now()
    ed.telemetry.pointerType = 'wintab'
    mouse('pointerdown', 600, 600, 1)
    mouse('pointermove', 620, 600, 1)
    mouse('pointerup', 620, 600, 0)
    R.badgeStaysWintab = ed.telemetry.pointerType === 'wintab'

    // ---- and the suppressed events must leave NO ink ----------------------
    const ink = () => {
      const d = ed.doc.active.surface.ctx.getImageData(0, 0, ed.doc.width, ed.doc.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 64) if (d[i] > 8) n++
      return n
    }
    // Drive along a path derived from DOCUMENT coordinates, so the dabs are
    // guaranteed to land on the paper. An earlier version used raw screen
    // coordinates that fell outside the canvas at fit zoom, so this assertion
    // passed even with the bug present — a test that proved nothing.
    const screenAt = (dx, dy) => ed.camera.docToScreen(dx, dy)
    const p0 = screenAt(400, 400)
    const p1 = screenAt(1600, 1000)

    // sanity: the same path with suppression OFF must actually make ink,
    // otherwise the negative result below is meaningless
    ed.doc.active.surface.clear()
    ed.penSource = 'pointer'
    ed.lastWintabAt = -Infinity
    for (let i = 0; i <= 40; i++) {
      const t = i / 40
      mouse(i === 0 ? 'pointerdown' : 'pointermove',
            p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t, 1)
    }
    mouse('pointerup', p1.x, p1.y, 0)
    R.controlPathMakesInk = ink() > 0

    ed.doc.active.surface.clear()
    ed.penSource = 'wintab'
    for (let i = 0; i <= 40; i++) {
      const t = i / 40
      ed.lastWintabAt = performance.now()
      mouse(i === 0 ? 'pointerdown' : 'pointermove',
            p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t, 1)
    }
    mouse('pointerup', p1.x, p1.y, 0)
    R.noInkFromSuppressedMouse = ink() === 0

    // ---- Wintab must respect UI and modifiers ----------------------------
    // Wintab receives bare screen coordinates: no DOM targeting, no keyboard
    // state. Both of these shipped broken — the pen painted straight through
    // floating panels, and space-to-pan did nothing.
    const wtMod = window.__wintabMods
    const feed = window.__wintabFeed
    R.wintabTestHooksPresent = Boolean(wtMod && feed)

    if (wtMod && feed) {
      const sample = (x, y, buttons, pressure = 0.6) => ({
        t: performance.now(), x, y, buttons, pressure,
        tilt: 0, twist: 0, inverted: false
      })
      const panel = document.querySelector('.floating-panel')
      const canvasRect = cv.getBoundingClientRect()

      // (a) pressing over a floating panel must NOT paint
      ed.doc.active.surface.clear()
      ed.history.clear()
      if (panel) {
        const pr = panel.getBoundingClientRect()
        const px = pr.left + pr.width / 2
        const py = pr.top + 40
        feed([sample(px, py, 1)])
        R.panelPressDoesNotPaint = !ed.strokeActive
        feed([sample(px + 30, py + 30, 1)])
        feed([sample(px + 30, py + 30, 0)])
        R.panelPressLeavesNoInk = ink() === 0
      } else {
        R.panelPressDoesNotPaint = 'no panel found'
        R.panelPressLeavesNoInk = 'no panel found'
      }

      // (b) over the canvas it must paint
      const cx = canvasRect.left + canvasRect.width * 0.4
      const cy = canvasRect.top + canvasRect.height * 0.5
      feed([sample(cx, cy, 1)])
      R.canvasPressPaints = ed.strokeActive
      feed([sample(cx + 40, cy + 10, 1)])
      feed([sample(cx + 40, cy + 10, 0)])

      // (c) holding space must pan, not paint
      ed.camera.scale = 1
      const cxBefore = ed.camera.cx
      wtMod.space = true
      feed([sample(cx, cy, 1)])
      R.spacePansNotPaints = !ed.strokeActive
      feed([sample(cx - 60, cy, 1)])
      feed([sample(cx - 60, cy, 0)])
      R.spaceActuallyPanned = ed.camera.cx !== cxBefore
      wtMod.space = false

      // (d) alt picks colour instead of painting
      wtMod.alt = true
      feed([sample(cx, cy, 1)])
      R.altPicksNotPaints = !ed.strokeActive
      feed([sample(cx, cy, 0)])
      wtMod.alt = false
    }

    ed.penSource = 'pointer'
    ed.lastWintabAt = -Infinity

    R.failed = !(
      R.mouseWorksWithoutWintab && R.wintabRecentTrue &&
      R.mouseSuppressedDuringWintab && R.penSuppressedDuringWintab &&
      R.wintabRecentExpires && R.mouseResumesAfterWintabIdle &&
      R.badgeStaysWintab && R.controlPathMakesInk && R.noInkFromSuppressedMouse &&
      R.wintabTestHooksPresent &&
      R.panelPressDoesNotPaint === true && R.panelPressLeavesNoInk === true &&
      R.canvasPressPaints && R.spacePansNotPaints && R.spaceActuallyPanned &&
      R.altPicksNotPaints
    )
    return R
  })()`)

  result.consoleErrors = errors
  if (errors.length > 0) result.failed = true

  console.log('WINTAB_INPUT ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
