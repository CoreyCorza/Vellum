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

  // Panel headers: no decorative dash, view options behind a hamburger, and no
  // second header inside the body repeating what the panel is called.
  // Titled panels carry no dash. The rail variant's <i> is its grip, not decoration,
  // so it is excluded rather than counted as a regression.
  R.noDecorativeDash =
    document.querySelectorAll('.floating-panel-head:not(.rail-head) i').length === 0
  R.shelfHasNoInnerHeader = !document.querySelector('.preset-shelf .sec-head')
  // No title text at all. Asserted on the header's text rather than on a span,
  // because the rail variant renders a grip instead of a title element.
  const railHead = [...document.querySelectorAll('.floating-panel-head')]
    .find((h) => h.closest('.floating-panel').querySelector('.quickrail'))
  R.quickRailHasNoTitle = railHead ? railHead.textContent.trim() === '' : false

  const shelfPanel = document.querySelector('.preset-shelf').closest('.floating-panel')
  const ham = shelfPanel.querySelector('.panel-menu')
  R.shelfHasHeaderMenu = !!ham
  const boxBefore = shelfPanel.getBoundingClientRect()
  // A press on the header drags the panel, so the button must keep its own press.
  ham.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 41, clientX: 5, clientY: 5, bubbles: true, isPrimary: true, button: 0 }))
  ham.click()
  await sleep(240)
  const pop = document.querySelector('.popover')
  R.headerMenuOpens = !!pop
  R.headerMenuHasViewOptions = pop
    ? ['List', 'Icons'].every((t) => [...pop.querySelectorAll('button')].some((b) => b.textContent.trim() === t))
    : false
  R.openingMenuDoesNotDragPanel =
    Math.round(shelfPanel.getBoundingClientRect().left) === Math.round(boxBefore.left)

  // The quick rail wears the tool rail's chrome, because a strip of two sliders is
  // more of a rail than a panel. Compared against the tool rail rather than against
  // fixed numbers, so the two cannot drift apart.
  const grip = document.querySelector('.rail-grab')
  const railGrip = document.querySelector('.rail-head')
  R.railHeadExists = !!railGrip
  if (grip && railGrip) {
    const shape = (el) => {
      const i = el.querySelector('i')
      const c = getComputedStyle(i)
      const r = i.getBoundingClientRect()
      return [Math.round(r.width), Math.round(r.height), c.backgroundColor, c.opacity].join('|')
    }
    R.gripsMatch = shape(grip) === shape(railGrip)
    R.gripHeightsMatch =
      Math.round(grip.getBoundingClientRect().height) ===
      Math.round(railGrip.getBoundingClientRect().height)
    R.railHeadHasNoTitleBar = getComputedStyle(railGrip).backgroundColor === 'rgba(0, 0, 0, 0)'
  }

  // The resize grip is hidden until the pointer is on the panel. Read from the
  // ::after opacity, which is where the rule lives; the handle itself stays
  // hit-testable at all times so resizing never depends on seeing it first.
  // The resize handle directly, not the first panel's handle. Once the Quick rail is open the first
  // .floating-panel is a rail, which has a drag grip but no resize handle, so the old query returned
  // null for a reason unrelated to the grip. No backticks in this comment: it lives in a template
  // literal, and one would end it early.
  const handle = document.querySelector('.floating-panel-resize')
  /*
   * Read from the stylesheet, not from the computed style.
   *
   * The computed value depends on :hover, and :hover tracks the REAL mouse — even for a window that
   * is never shown, Chromium still decides whether the cursor is over it. So this passed or failed
   * depending on where the person running it had left their hand: five for five one minute, nought
   * for three the next, with no code change in between. A test that reports the position of a mouse
   * is worse than no test, because it teaches you to ignore it.
   *
   * The rules themselves say what the intent is: hidden at rest, shown on hover.
   */
  // No regex, no backslash escapes: this whole file is a plain template literal, so a source \s
  // becomes a bare s when the literal is evaluated, and /\s+/ silently turns into /s+/ — which was
  // deleting the s from '.floating-panel-resize::after' so nothing ever matched. Plain string checks
  // on the raw selector text avoid the whole trap.
  const opacityOfRule = (needleHas, needleLacks) => {
    for (const sheet of document.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch (e) { continue }
      for (const rule of rules) {
        if (!rule.selectorText) continue
        const sel = rule.selectorText
        if (sel.includes('.floating-panel-resize::after') && sel.includes(needleHas) &&
            (needleLacks === '' || !sel.includes(needleLacks))) {
          return Number(rule.style.opacity)
        }
      }
    }
    return null
  }
  const restOpacity = opacityOfRule('.floating-panel-resize::after', ':hover')
  const hoverOpacity = opacityOfRule(':hover', '')
  R.gripHiddenAtRest = handle !== null && restOpacity === 0
  R.gripShownOnHover = (hoverOpacity || 0) > 0
  R.gripStaysHitTestable = handle ? getComputedStyle(handle).pointerEvents !== 'none' : false

  // Toggling a pen dynamic must not move anything. The curves used to be added and
  // removed, so every tick shifted the controls below and left a hole at the bottom
  // of the panel.
  // Curves stay present and dim when their dynamic is off, rather than being added
  // and removed — which used to move every control below them. Measured inside the
  // Pen dynamics pane, using the Min size slider that sits below all three curves as
  // the marker.
  const dynTab = [...document.querySelectorAll('.cat-item')].find((i) =>
    i.textContent.includes('Pen dynamics')
  )
  if (dynTab) {
    dynTab.click()
    await sleep(260)
    const pane = document.querySelector('.cat-pane')
    const marker = () =>
      [...document.querySelectorAll('.cat-pane-body .sl')].find(
        (n) => n.getAttribute('aria-label') === 'Min size'
      )

    ed.setBrush({ pressureToSize: true, pressureToFlow: true, pressureToOpacity: true })
    await sleep(260)
    const onY = Math.round(marker().getBoundingClientRect().top)
    const onH = pane.scrollHeight
    const onCurves = document.querySelectorAll('.curve-editor').length

    ed.setBrush({ pressureToSize: false, pressureToFlow: false, pressureToOpacity: false })
    await sleep(260)
    R.curvesStayPresent = document.querySelectorAll('.curve-editor').length === onCurves
    R.curvesDimWhenOff = document.querySelectorAll('.curve-editor.disabled').length === onCurves
    R.togglingDoesNotShiftLayout =
      Math.round(marker().getBoundingClientRect().top) === onY && pane.scrollHeight === onH

    const offCanvas = document.querySelector('.curve-editor.disabled canvas')
    R.disabledCurveIgnoresInput = offCanvas
      ? getComputedStyle(offCanvas).pointerEvents === 'none'
      : false
    ed.setBrush({ pressureToSize: true })
  }

  // Checkboxes are drawn, not tinted: accent-color leaves a white box and a
  // system-blue fill that match nothing else here.
  const box = document.querySelector('.chk input[type=checkbox]')
  R.checkboxIsThemed = box
    ? getComputedStyle(box).appearance === 'none' &&
      getComputedStyle(box).backgroundColor !== 'rgba(0, 0, 0, 0)'
    : false

  // Settings are grouped into categories: a fixed list beside a pane. Collapsible
  // sections were tried and rejected because expanding one moved everything below
  // it. The property that matters is therefore geometric — switching category must
  // not move the list or resize the pane.
  const items = () => [...document.querySelectorAll('.cat-item')]
  R.hasCategories = items().length >= 5
  const listBox = () => document.querySelector('.cat-list').getBoundingClientRect()
  const paneBox = () => document.querySelector('.cat-pane').getBoundingClientRect()
  const firstList = listBox()
  const firstPane = paneBox()
  let steady = true
  for (const it of items()) {
    it.click()
    await sleep(150)
    const l = listBox()
    const pn = paneBox()
    if (
      Math.round(l.height) !== Math.round(firstList.height) ||
      Math.round(l.width) !== Math.round(firstList.width) ||
      Math.round(pn.top) !== Math.round(firstPane.top) ||
      Math.round(pn.height) !== Math.round(firstPane.height)
    ) {
      steady = false
    }
  }
  R.switchingCategoryMovesNothing = steady

  // Only one pane's controls exist at a time, which is what keeps the panel a fixed
  // size however many categories get added.
  R.onePaneAtATime = document.querySelectorAll('.cat-pane-body').length === 1

  // Sketched categories are inert, so nothing looks live that is not.
  ;[...items()].find((i) => i.textContent.includes('Texture')).click()
  await sleep(200)
  const plannedBody = document.querySelector('.cat-pane-body.planned')
  R.plannedCategoryIsInert = !!plannedBody && getComputedStyle(plannedBody).pointerEvents === 'none'
  ;[...items()].find((i) => i.textContent.includes('Brush')).click()
  await sleep(150)

  // A live stroke of the current brush, since with categories closed you can only
  // see a few settings at once and something has to show the combined result.
  // A canvas, not an <img>: the first version swapped a data URL into an img on
  // every change, which meant a PNG encode and decode per frame while scrubbing.
  // Compared by PIXELS rather than by a src string, which is both what changed and
  // a stronger claim — a stale canvas would pass a src check trivially.
  const strip = document.querySelector('.stroke-preview canvas')
  R.livePreviewExists = !!strip && strip.width > 0 && strip.height > 0
  const sampleStrip = () => {
    const g = strip.getContext('2d')
    const d = g.getImageData(0, 0, strip.width, strip.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4 * 53) sum += d[i] + d[i + 3]
    return sum
  }
  const wasInk = strip ? sampleStrip() : 0
  ed.setBrush({ size: 12, hardness: 1, pressureToSize: false })
  await sleep(420)
  R.livePreviewFollowsTheBrush = strip ? sampleStrip() !== wasInk : false

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
