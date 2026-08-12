/**
 * Panel visibility and the quick rail.
 *
 * Worth guarding because the failure is confusing rather than loud: a panel that
 * will not reopen, or a Panels menu missing an entry, leaves someone with no way
 * back to a panel they closed. And closing a panel must UNMOUNT it — the brush
 * shelf holds a WebGL context for its previews, so merely hiding it would leak one
 * per close.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 90000)

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const R = {}
  const ed = window.editor
  const menu = (name) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent.trim() === name)
  const item = (text) => [...document.querySelectorAll('.menu-item')].find((i) => i.textContent.includes(text))

  R.panelsMenuExists = !!menu('Panels')
  menu('Panels').click()
  await sleep(200)
  const labels = [...document.querySelectorAll('.menu-item')].map((i) => i.textContent.replace('✓', '').trim())
  R.listsEveryPanel = ['Brush Settings', 'Brushes', 'Colour', 'Layers', 'Quick rail'].every((l) => labels.includes(l))

  // Closing a panel must unmount it, not hide it: the shelf owns a WebGL context.
  R.shelfOpenToStart = !!document.querySelector('.preset-shelf')
  item('Brushes').click()
  await sleep(280)
  R.closingUnmounts = !document.querySelector('.preset-shelf')

  menu('Panels').click()
  await sleep(200)
  item('Brushes').click()
  await sleep(280)
  R.reopeningWorks = !!document.querySelector('.preset-shelf')

  // The quick rail duplicates controls that already have a home, so it starts off.
  menu('Panels').click()
  await sleep(200)
  R.railStartsClosed = !document.querySelector('.quickrail')
  item('Quick rail').click()
  await sleep(300)
  R.railOpens = !!document.querySelector('.quickrail')
  R.railHasTwoSliders = document.querySelectorAll('.railsl').length === 2

  // Its size slider must move the same value the panel slider does.
  const sl = document.querySelector('.railsl')
  sl.setPointerCapture = () => {}
  const r = sl.getBoundingClientRect()
  const before = ed.brush.size
  sl.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: r.left + r.width / 2, clientY: r.bottom - 6, bubbles: true, isPrimary: true, button: 0, pointerType: 'mouse' }))
  await sleep(60)
  R.readoutShowsWhileDragging = !!document.querySelector('.railsl-readout')
  // Portalled, because the rail is barely wider than the slider and panels clip.
  const ro = document.querySelector('.railsl-readout')
  R.readoutEscapesPanel = ro ? ro.parentElement === document.body : false
  sl.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: r.left + r.width / 2, clientY: r.top + 6, bubbles: true }))
  await sleep(60)
  R.railDragChangesSize = ed.brush.size > before
  sl.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: r.left + r.width / 2, clientY: r.top + 6, bubbles: true }))
  await sleep(140)
  R.readoutHidesAfter = !document.querySelector('.railsl-readout')

  // The choice has to survive a restart, or every session starts by reopening things.
  const stored = JSON.parse(localStorage.getItem('vellum.prefs') || '{}')
  R.choicePersisted = Array.isArray(stored.hiddenPanels) && !stored.hiddenPanels.includes('quick-rail')

  // The thumb must stay wholly inside the track. The track is what receives the
  // press, so a thumb hanging half outside it at min or max looks clickable and
  // is not.
  const thumbInside = () => {
    const t = sl.querySelector('.railsl-thumb').getBoundingClientRect()
    const b = sl.getBoundingClientRect()
    return t.top >= b.top - 0.6 && t.bottom <= b.bottom + 0.6
  }
  ed.setBrush({ size: 1 })
  await sleep(150)
  R.thumbInsideAtMin = thumbInside()
  ed.setBrush({ size: 400 })
  await sleep(150)
  R.thumbInsideAtMax = thumbInside()

  // A size in pixels is not something anyone can picture, so dragging either size
  // slider shows the ring.
  sl.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 21, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, isPrimary: true, button: 0, pointerType: 'mouse' }))
  await sleep(100)
  R.railShowsSizeRing = ed.brushPreview.active === true
  sl.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }))
  await sleep(100)
  R.ringHidesAfterDrag = ed.brushPreview.active === false

  const panelSize = [...document.querySelectorAll('.sl')].find((n) => n.getAttribute('aria-label') === 'Size')
  panelSize.setPointerCapture = () => {}
  const pr = panelSize.getBoundingClientRect()
  panelSize.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 22, clientX: pr.left + pr.width * 0.4, clientY: pr.top + pr.height / 2, bubbles: true, isPrimary: true, button: 0, pointerType: 'mouse' }))
  await sleep(100)
  R.panelSliderShowsSizeRing = ed.brushPreview.active === true
  panelSize.dispatchEvent(new PointerEvent('pointerup', { pointerId: 22, clientX: pr.left + pr.width * 0.4, clientY: pr.top + pr.height / 2, bubbles: true }))
  await sleep(100)

  // The ring is drawn on its own canvas above the panels. Drawn into the main one
  // it appeared BEHIND whichever panel held the slider being dragged — exactly
  // where you are looking — and it printed a second copy of a number the slider was
  // already showing.
  const ov = document.querySelector('#overlay')
  R.overlayExists = !!ov
  R.overlayAbovePanels = ov ? Number(getComputedStyle(ov).zIndex) > 1000 : false
  R.overlayIgnoresPointer = ov ? getComputedStyle(ov).pointerEvents === 'none' : false

  ed.setBrush({ size: 240 })
  ed.showBrushPreview(400, 300)
  await sleep(220)
  R.sliderRingHasNoLabel = ed.brushPreview.label === false
  if (ov) {
    const px = ov.getContext('2d').getImageData(0, 0, ov.width, ov.height).data
    let painted = 0
    for (let i = 3; i < px.length; i += 4 * 97) if (px[i] > 8) painted++
    R.ringPaintsOnOverlay = painted > 20
  }
  ed.hideBrushPreview()
  await sleep(200)
  if (ov) {
    const px = ov.getContext('2d').getImageData(0, 0, ov.width, ov.height).data
    let painted = 0
    for (let i = 3; i < px.length; i += 4 * 97) if (px[i] > 8) painted++
    R.overlayClearsWhenDone = painted === 0
  }

  // The Alt+RMB scrub keeps its label: there may be no panel open to show one.
  ed.beginSizeScrub(300, 300, 'keys')
  R.scrubKeepsItsLabel = ed.brushPreview.label === true
  ed.endSizeScrub('keys')

  // The dab is drawn at the brush's real opacity, so the preview answers the
  // opacity slider as well as the size one. Sampled rather than trusted: a fixed
  // alpha would look plausible and say nothing.
  const g2 = ov && ov.getContext('2d')
  const dpr = Math.min(window.devicePixelRatio, 2)
  const centreAlpha = async (op) => {
    ed.setBrush({ size: 220, hardness: 0.9, opacity: op })
    ed.showBrushPreview(500, 320)
    await sleep(220)
    return g2.getImageData(Math.round(500 * dpr), Math.round(320 * dpr), 1, 1).data[3]
  }
  const a10 = await centreAlpha(0.1)
  const a50 = await centreAlpha(0.5)
  const a100 = await centreAlpha(1)
  R.dabTracksOpacity = a10 < a50 && a50 < a100
  R.dabAlphaIsAccurate = Math.abs(a10 - 26) < 12 && Math.abs(a50 - 128) < 14 && a100 > 240
  ed.hideBrushPreview()
  await sleep(150)

  // and the opacity slider opens it, not just the size one
  const opacityRail = [...document.querySelectorAll('.railsl')][1]
  opacityRail.setPointerCapture = () => {}
  const orr = opacityRail.getBoundingClientRect()
  opacityRail.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 31, clientX: orr.left + orr.width / 2, clientY: orr.top + orr.height * 0.4, bubbles: true, isPrimary: true, button: 0, pointerType: 'mouse' }))
  await sleep(130)
  R.opacitySliderOpensPreview = ed.brushPreview.active === true
  opacityRail.dispatchEvent(new PointerEvent('pointerup', { pointerId: 31, clientX: orr.left + orr.width / 2, clientY: orr.top + orr.height * 0.4, bubbles: true }))
  await sleep(130)
  R.previewClosesAfterOpacityDrag = ed.brushPreview.active === false

  // Menu items must line up. Adding a tick column to every menu gave each item a
  // third flex child, and space-between then pushed the labels of File, Edit and
  // View into the middle of the popup. The column is now reserved only where
  // something can be ticked, and the label takes the slack in both cases.
  const alignment = []
  for (const name of ['File', 'Edit', 'View', 'Panels']) {
    const btn = [...document.querySelectorAll('.menu-title')].find((b) => b.textContent.trim() === name)
    btn.click()
    await sleep(180)
    const pop = document.querySelector('.menu-pop').getBoundingClientRect()
    const items = [...document.querySelectorAll('.menu-item')]
    const lefts = new Set(items.map((i) => Math.round(i.querySelector('.menu-label').getBoundingClientRect().left - pop.left)))
    const rights = new Set(
      items.filter((i) => i.querySelector('.menu-shortcut'))
        .map((i) => Math.round(pop.right - i.querySelector('.menu-shortcut').getBoundingClientRect().right))
    )
    alignment.push({ name, lefts: lefts.size, rights: rights.size })
    btn.click()
    await sleep(120)
  }
  R.labelsShareALeftEdge = alignment.every((a) => a.lefts === 1)
  R.shortcutsShareARightEdge = alignment.every((a) => a.rights <= 1)

  R.failed = Object.entries(R).some(([k, v]) => k !== 'failed' && v !== true)
  return R
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 950, show: true,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))
  // A stored layout from an earlier run would decide the answers here.
  await win.webContents.executeJavaScript('(() => { localStorage.clear(); location.reload(); return 1 })()')
  await new Promise((r) => setTimeout(r, 2600))
  const R = await win.webContents.executeJavaScript(SCRIPT)
  process.stdout.write('PANELS ' + JSON.stringify(R, null, 2) + '\n')
  app.exit(R.failed ? 1 : 0)
})
