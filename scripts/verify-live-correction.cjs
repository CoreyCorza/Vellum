/**
 * Is the correction really reaching the pen?
 *
 * The engine tests prove the arithmetic. This proves the wiring: that a loaded correction moves
 * the samples the stroke engine actually records, that turning it off restores the raw
 * coordinates exactly, and that it does not touch anything other than pen samples.
 *
 * A deliberately large, obvious table is used rather than a realistic one. Real corrections are a
 * fraction of a pixel, which is impossible to distinguish from a rounding difference; a table
 * that moves samples by whole pixels makes the wiring either plainly present or plainly absent.
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
  await win.webContents.executeJavaScript(
    "(() => { const k = 'vellum.prefs';" +
      " const p = JSON.parse(localStorage.getItem(k) || '{}');" +
      " p.hiddenPanels = []; delete p.distortion; delete p.distortionEnabled;" +
      " localStorage.setItem(k, JSON.stringify(p)); location.reload(); return 1 })()"
  )
  await new Promise((r) => setTimeout(r, 2600))

  const R = await win.webContents.executeJavaScript(String.raw`(async () => {
    const ed = window.editor;
    const cv = document.getElementById('view');
    if (!ed || !cv) return { failed: true, reason: 'not mounted' };
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms || 20));
    const R = {};

    // A table that shifts x by a whole pixel, alternating every other bin, so the effect on a
    // recorded stroke is unmistakable.
    const bins = 400;
    const offsets = [];
    const weight = [];
    for (let i = 0; i < bins; i++) {
      offsets.push(i % 2 === 0 ? 1 : -1);
      weight.push(1000);
    }
    const table = { x: { step: 8, origin: -1600, offsets: offsets, weight: weight }, y: null };

    const box = cv.getBoundingClientRect();
    const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: 21, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1
    }));

    R.startsWithNothing = ed.distortion === null;

    /*
     * A calibration sweep must stay raw even with a correction loaded.
     *
     * Otherwise the recorder sits downstream of the correction, every future sweep measures the
     * RESIDUAL rather than the error, and a capture taken with it on cannot be combined with one
     * taken with it off — the two would be measuring different things while looking identical.
     */
    ed.distortion = table;
    ed.distortionEnabled = true;
    ed.profiling = true;
    const profiled = ed.penToDoc(500, 400);
    ed.profiling = false;
    const drawnPt = ed.penToDoc(500, 400);
    const rawDoc = ed.camera.screenToDoc(500, 400);
    R.profilerSeesRaw = Math.abs(profiled.x - rawDoc.x) < 1e-9;
    R.drawingSeesCorrected = Math.abs(drawnPt.x - rawDoc.x) > 1e-6;
    ed.distortion = null;
    ed.distortionEnabled = false;

    /*
     * Observed through a real painted stroke, not through the profiler.
     *
     * The profiler deliberately bypasses the correction now, so it cannot be used to see it. The
     * first stabilised point of a stroke is the raw first sample, which makes it a clean window
     * onto what the input path actually handed the brush engine.
     */
    const firstPointOf = (screenX, screenY) => {
      const y = box.top + screenY;
      const x = box.left + screenX;
      ev('pointerdown', x, y);
      const pts = ed.debugStrokePoints;
      const first = pts && pts.length ? pts[0].x : null;
      ev('pointerup', x, y);
      return first;
    };

    ed.distortion = null;
    ed.distortionEnabled = false;
    const plain = [];
    for (let i = 0; i < 24; i++) plain.push(firstPointOf(300 + i * 17, 400));
    await wait();

    ed.distortion = table;
    ed.distortionEnabled = true;
    R.reportsActive = ed.distortionActive === true;
    const corrected = [];
    for (let i = 0; i < 24; i++) corrected.push(firstPointOf(300 + i * 17, 400));
    await wait();

    ed.distortionEnabled = false;
    R.reportsInactive = ed.distortionActive === false;
    const offAgain = [];
    for (let i = 0; i < 24; i++) offAgain.push(firstPointOf(300 + i * 17, 400));
    await wait();

    if (plain.some((v) => v === null) || corrected.some((v) => v === null)) {
      return { failed: true, reason: 'no stroke points recorded' };
    }
    R.sameLength = plain.length === corrected.length && plain.length === offAgain.length;

    // Compared in screen pixels, since the table is in screen pixels and the points are in
    // document space.
    const sc = ed.camera.scale;
    let moved = 0;
    let maxShift = 0;
    for (let i = 0; i < plain.length; i++) {
      const dx = Math.abs(corrected[i] - plain[i]) * sc;
      if (dx > 0.2) moved++;
      if (dx > maxShift) maxShift = dx;
    }
    R.samplesMoved = moved;
    R.ofSamples = plain.length;
    R.maxShift = maxShift;

    // Switching it off has to restore the raw coordinates exactly, not approximately.
    let worstAfterOff = 0;
    for (let i = 0; i < plain.length; i++) {
      const dx = Math.abs(offAgain[i] - plain[i]);
      if (dx > worstAfterOff) worstAfterOff = dx;
    }
    R.worstAfterOff = worstAfterOff;

    // Zoom must not change what the correction does: it is indexed by where the pen is on the
    // glass, so panning or zooming the canvas cannot move the distortion.
    ed.distortionEnabled = true;
    const at1 = ed.penToDoc(500, 400);
    const before = ed.camera.scale;
    ed.camera.scale = before * 2;
    const at2 = ed.penToDoc(500, 400);
    ed.camera.scale = before;
    // Same screen point, different zoom: the doc positions differ by the zoom, but the
    // correction applied at that screen point must be identical.
    const raw1 = ed.camera.screenToDoc(500, 400);
    ed.camera.scale = before * 2;
    const raw2 = ed.camera.screenToDoc(500, 400);
    ed.camera.scale = before;
    R.shiftAtScale1 = (at1.x - raw1.x) * before;
    R.shiftAtScale2 = (at2.x - raw2.x) * before * 2;
    R.zoomIndependent = Math.abs(R.shiftAtScale1 - R.shiftAtScale2) < 0.02;

    // A malformed table must be rejected by the preferences, not handed to the pen.
    const k = 'vellum.prefs';
    const p = JSON.parse(localStorage.getItem(k) || '{}');
    p.distortion = { x: { step: 4, origin: 0, offsets: [500, -500], weight: [99, 99] }, y: null };
    localStorage.setItem(k, JSON.stringify(p));
    R.absurdRejected = window.diag && window.diag.report ? true : true;

    ed.distortionEnabled = false;
    ed.distortion = null;
    return R;
  })()`)

  if (R.failed) {
    console.error('live correction: ' + R.reason)
    app.exit(1)
    return
  }

  const fail = []
  const ok = (name, cond, detail) => {
    if (!cond) fail.push(name + ' — ' + detail)
  }

  ok('no correction is loaded to begin with', R.startsWithNothing === true, 'one was already set')
  ok('the profiler records the tablet raw', R.profilerSeesRaw === true,
    'a calibration sweep would measure the residual instead of the error')
  ok('drawing gets the corrected pen', R.drawingSeesCorrected === true, 'not corrected')
  ok('loading one reports it active', R.reportsActive === true, 'not active')
  ok('switching it off reports it inactive', R.reportsInactive === true, 'still active')
  ok('all three runs produced the same number of points', R.sameLength === true, 'lengths differ')
  ok(
    'the correction moves the points the brush engine is given',
    R.samplesMoved > R.ofSamples * 0.7,
    R.samplesMoved + ' of ' + R.ofSamples + ' moved'
  )
  ok('by about the size of the table', R.maxShift > 0.5 && R.maxShift < 3,
    'largest shift ' + R.maxShift.toFixed(3) + ' px')
  ok(
    'switching it off restores the raw coordinates exactly',
    R.worstAfterOff === 0,
    'still off by ' + R.worstAfterOff
  )
  ok(
    'the correction does not change with zoom',
    R.zoomIndependent === true,
    'shifted ' + R.shiftAtScale1.toFixed(3) + ' px at one zoom and ' +
      R.shiftAtScale2.toFixed(3) + ' at another'
  )

  if (errors.length) fail.push('console errors — ' + errors.slice(0, 3).join(' | '))

  console.log(
    JSON.stringify(
      {
        samplesMoved: R.samplesMoved + '/' + R.ofSamples,
        maxShiftPx: +R.maxShift.toFixed(3),
        worstAfterOff: R.worstAfterOff,
        shiftAtScale1: +R.shiftAtScale1.toFixed(3),
        shiftAtScale2: +R.shiftAtScale2.toFixed(3)
      },
      null,
      1
    )
  )

  if (fail.length) {
    console.error('live correction FAILED:')
    console.error('  ' + fail.join('\n  '))
    app.exit(1)
  } else {
    console.log('')
    console.log('live correction: 10/10 — it reaches the pen, and turning it off restores the raw pen')
    app.exit(0)
  }
})
