/**
 * Selections, clipped paint, pixel transform, and symmetry lockstep.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 90000)

const SCRIPT = `(() => {
  const ed = window.editor
  if (!ed) return { failed: true, reason: 'no editor handle' }
  const R = {}

  const sp = (x, y, p) => ({ x, y, pressure: p, tilt: 0, twist: 0, t: performance.now() })
  const stroke = (pts, erase = false) => {
    ed.beginStroke(sp(pts[0][0], pts[0][1], pts[0][2]), erase)
    for (let i = 1; i < pts.length; i++) ed.extendStroke(sp(pts[i][0], pts[i][1], pts[i][2]))
    ed.endStroke()
  }
  const line = (x0, y0, x1, y1, n = 80, p = 1) => {
    const a = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      a.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p])
    }
    return a
  }
  const alpha = (x, y) => ed.doc.active.surface.sample(Math.round(x), Math.round(y))[3]
  const ink = (x, y) => alpha(x, y) > 8
  const W = ed.doc.width
  const H = ed.doc.height
  const cx = W / 2

  const reset = () => {
    while (ed.doc.layers.length > 1) ed.doc.removeLayer(ed.doc.layers.length - 1)
    ed.doc.activeIndex = 0
    ed.doc.layers[0].surface.clear()
    ed.history.clear()
    ed.compositor.invalidate()
    ed.deselect()
    ed.history.clear()
    ed.setBrush({
      size: 50, hardness: 1, opacity: 1, flow: 1, spacing: 0.05,
      pressureToSize: false, pressureToOpacity: false, pressureToFlow: false,
      stabilise: 0, color: '#ff0000', symmetry: 'none'
    })
    ed.setTool('brush')
  }

  // ---- 1. rect / ellipse / lasso ------------------------------------------
  reset()
  ed.selectRect(100, 120, 80, 60)
  R.rect = {
    inside: ed.selection.contains(140, 150),
    outside: !ed.selection.contains(90, 150),
    active: ed.selection.active
  }

  ed.selectEllipse(400, 400, 120, 80)
  R.ellipse = {
    centre: ed.selection.contains(460, 440),
    corner: !ed.selection.contains(401, 401),
    active: ed.selection.active
  }

  ed.selectLasso([
    { x: 700, y: 200 },
    { x: 860, y: 200 },
    { x: 860, y: 340 },
    { x: 700, y: 340 }
  ])
  R.lasso = {
    inside: ed.selection.contains(780, 270),
    outside: !ed.selection.contains(690, 270),
    active: ed.selection.active
  }

  // ---- 2. paint / erase clipped to the selection ---------------------------
  reset()
  ed.selectRect(400, 400, 200, 200)
  stroke(line(300, 500, 800, 500))
  R.paintClip = {
    inside: ink(500, 500),
    outsideLeft: !ink(350, 500),
    outsideRight: !ink(650, 500)
  }

  reset()
  ed.doc.layers[0].surface.fill('#000000')
  ed.selectRect(400, 400, 200, 200)
  ed.history.clear()
  stroke(line(300, 500, 800, 500), true)
  R.eraseClip = {
    insideCleared: alpha(500, 500) < 200,
    outsideKept: alpha(350, 500) > 200
  }

  // ---- 3. undo / redo of selection ----------------------------------------
  reset()
  ed.selectRect(100, 100, 50, 50)
  const selected = ed.selection.active && ed.selection.contains(125, 125)
  ed.undo()
  const afterUndoSel = !ed.selection.active
  ed.redo()
  R.selectionUndo = {
    selected,
    afterUndo: afterUndoSel,
    afterRedo: ed.selection.active && ed.selection.contains(125, 125)
  }

  // ---- 4. undo / redo of transforming selected pixels ---------------------
  reset()
  stroke(line(300, 400, 300, 600, 40))
  const beforeMove = ink(300, 500)
  ed.selectRect(250, 350, 100, 300)
  ed.moveSelection(40, 20)
  const moved = ink(340, 520) && !ink(300, 500)
  ed.undo()
  const undone = ink(300, 500) && !ink(340, 520)
  ed.redo()
  R.transformUndo = {
    beforeMove,
    moved,
    undone,
    redone: ink(340, 520) && !ink(300, 500)
  }

  // ---- 5. symmetry: select one side selects the mirrored side(s) ----------
  reset()
  ed.setBrush({ symmetry: 'x' })
  ed.selectRect(100, 100, 80, 80)
  R.symXSelect = {
    left: ed.selection.contains(140, 140),
    right: ed.selection.contains(2 * cx - 140, 140)
  }

  ed.setBrush({ symmetry: 'y' })
  ed.selectRect(200, 80, 60, 50)
  R.symYSelect = {
    top: ed.selection.contains(230, 105),
    bottom: ed.selection.contains(230, 2 * (H / 2) - 105)
  }

  ed.setBrush({ symmetry: 'xy' })
  ed.selectRect(150, 150, 40, 40)
  const px = 170, py = 170
  R.symXYSelect = {
    origin: ed.selection.contains(px, py),
    x: ed.selection.contains(2 * cx - px, py),
    y: ed.selection.contains(px, 2 * (H / 2) - py),
    xy: ed.selection.contains(2 * cx - px, 2 * (H / 2) - py)
  }

  // ---- 6. symmetry: transform one side transforms the other(s) ------------
  reset()
  ed.setBrush({ symmetry: 'x', color: '#00ff00', size: 18 })
  stroke(line(400, 400, 400, 900, 50))
  const left0 = ink(400, 650)
  const right0 = ink(W - 400, 650)
  ed.selectRect(340, 350, 120, 600)
  const rightSelected = ed.selection.contains(W - 400, 650)
  ed.moveSelection(80, 40)
  const leftNew = 400 + 80
  const rightNew = 2 * cx - leftNew
  R.symXTransform = {
    paintedBoth: left0 && right0,
    rightSelected,
    leftMoved: ink(leftNew, 690) && !ink(400, 650),
    rightMoved: ink(rightNew, 690) && !ink(W - 400, 650),
    lockstep: ink(leftNew, 690) && ink(rightNew, 690)
  }

  /* ---- 6b. a drag leaves nothing behind ----------------------------------
   *
   * The reported symptom was artefacts all over the canvas after transforming. The cause was that a
   * drag rewrote the layer on every pointer move, so any pointer event could leave a half-applied
   * edit behind. These are the checks that would have caught it.
   *
   * The strongest one is that the layer must not change AT ALL while the pointer is moving. Pixels
   * are lifted once when the gesture starts and put down once when it ends; everything between is
   * drawing. If that holds, residue is impossible rather than merely absent today.
   */
  reset()
  ed.setBrush({ symmetry: 'none', color: '#ff0000', size: 20 })
  stroke(line(300, 300, 700, 300, 60))
  const pristine = ed.doc.active.surface.extract({ x: 0, y: 0, w: W, h: H })
  const sameAsPristine = () => {
    const now = ed.doc.active.surface.extract({ x: 0, y: 0, w: W, h: H })
    const a = pristine.ctx.getImageData(0, 0, W, H).data
    const b = now.ctx.getImageData(0, 0, W, H).data
    let diff = 0
    for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) diff++
    return diff
  }

  ed.tool = 'transform'
  ed.selectRect(280, 280, 440, 60)
  ed.beginTransform({ x: 280, y: 280 })
  const afterLift = ed.doc.active.surface.extract({ x: 0, y: 0, w: W, h: H })
  // Drag a long way around, many events, then come back to where it started.
  for (let i = 0; i < 40; i++) ed.extendTransform({ x: 280 + i * 7, y: 280 + (i % 9) * 5 })
  for (let i = 40; i >= 0; i--) ed.extendTransform({ x: 280 + i * 7, y: 280 + (i % 9) * 5 })
  const duringDrag = ed.doc.active.surface.extract({ x: 0, y: 0, w: W, h: H })
  let movedDuringDrag = 0
  {
    const a = afterLift.ctx.getImageData(0, 0, W, H).data
    const b = duringDrag.ctx.getImageData(0, 0, W, H).data
    for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) movedDuringDrag++
  }
  ed.extendTransform({ x: 280, y: 280 })
  ed.endTransform()

  R.noResidue = {
    // The layer is untouched between lift and commit, however many events arrive.
    untouchedWhileDragging: movedDuringDrag === 0,
    // Ending where it began restores the original exactly, with nothing accumulated.
    returnsToOriginal: sameAsPristine() < 40,
    stillSelected: ed.selection.active
  }

  // Dragging somewhere and back again, as a fresh gesture each time, must also not accumulate.
  reset()
  ed.setBrush({ symmetry: 'none', color: '#0000ff', size: 20 })
  stroke(line(300, 500, 700, 500, 60))
  const before2 = ed.doc.active.surface.extract({ x: 0, y: 0, w: W, h: H })
  ed.tool = 'transform'
  ed.selectRect(280, 480, 440, 60)
  /*
   * Grabbed INSIDE the selection, which is a move. An earlier version of this grabbed a corner —
   * that is a scale, and repeatedly scaling down and back up resamples the pixels each time and
   * softens them, in this editor and in every other one. Losing detail to repeated resampling is
   * not the bug being tested for; accumulating residue from a translation is.
   */
  for (let k = 0; k < 4; k++) {
    ed.beginTransform({ x: 500, y: 510 })
    ed.extendTransform({ x: 600, y: 590 })
    ed.endTransform()
    ed.beginTransform({ x: 600, y: 590 })
    ed.extendTransform({ x: 500, y: 510 })
    ed.endTransform()
  }
  let driftAfterRoundTrips = 0
  {
    const a = before2.ctx.getImageData(0, 0, W, H).data
    const b = ed.doc.active.surface.extract({ x: 0, y: 0, w: W, h: H }).ctx.getImageData(0, 0, W, H).data
    for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8) driftAfterRoundTrips++
  }
  // A pure translation is lossless, so eight of them should return the exact pixels.
  R.roundTrips = { drift: driftAfterRoundTrips, clean: driftAfterRoundTrips < 40 }

  // ---- 6c. the outline is the shape, not its bounding box -------------------
  reset()
  ed.selectEllipse(200, 200, 400, 200)
  const outline = ed.selection.outline
  R.outline = {
    hasMany: outline.length > 20,
    // An ellipse's outline must not be its four corners: no point should sit at the corner.
    notABox: !outline.some((q) => Math.abs(q.x - 200) < 1 && Math.abs(q.y - 200) < 1)
  }
  ed.deselect()
  ed.tool = 'brush'

  // ---- 7. deselect / select-all -------------------------------------------
  reset()
  ed.selectRect(10, 10, 40, 40)
  ed.deselect()
  R.deselect = !ed.selection.active && !ed.selection.contains(20, 20)
  ed.selectAll()
  R.selectAll = ed.selection.active && ed.selection.contains(0, 0) && ed.selection.contains(W - 1, H - 1)
  ed.deselect()
  R.deselectAfterAll = !ed.selection.active

  R.failed = !(
    R.rect.inside && R.rect.outside && R.rect.active &&
    R.ellipse.centre && R.ellipse.corner && R.ellipse.active &&
    R.lasso.inside && R.lasso.outside && R.lasso.active &&
    R.paintClip.inside && R.paintClip.outsideLeft && R.paintClip.outsideRight &&
    R.eraseClip.insideCleared && R.eraseClip.outsideKept &&
    R.selectionUndo.selected && R.selectionUndo.afterUndo && R.selectionUndo.afterRedo &&
    R.transformUndo.beforeMove && R.transformUndo.moved && R.transformUndo.undone && R.transformUndo.redone &&
    R.symXSelect.left && R.symXSelect.right &&
    R.symYSelect.top && R.symYSelect.bottom &&
    R.symXYSelect.origin && R.symXYSelect.x && R.symXYSelect.y && R.symXYSelect.xy &&
    R.symXTransform.paintedBoth && R.symXTransform.rightSelected &&
    R.symXTransform.leftMoved && R.symXTransform.rightMoved && R.symXTransform.lockstep &&
    R.deselect && R.selectAll && R.deselectAfterAll &&
    R.noResidue.untouchedWhileDragging && R.noResidue.returnsToOriginal &&
    R.noResidue.stillSelected && R.roundTrips.clean &&
    R.outline.hasMany && R.outline.notABox
  )
  return R
})()`

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
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))
  const R = await win.webContents.executeJavaScript(SCRIPT)
  process.stdout.write('SELECTION ' + JSON.stringify(R, null, 2) + '\n')
  app.exit(R.failed ? 1 : 0)
})
