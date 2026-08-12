/**
 * The profiler stage, driven the way a person drives it.
 *
 * Every check here follows the same path a user takes: open it with its own button, pick a
 * test by clicking it, draw, and then look at the screen. That order matters, because the
 * two bugs this guards against were both invisible to a test that set up the mode itself
 * and dispatched events straight at the canvas.
 *
 *   - Picking a test tore down the trail hook and never put it back, so from the first
 *     click onward the pen left no line and the sample counter stayed at zero.
 *   - Finishing a recording never told the interface, so the result only appeared once some
 *     unrelated click forced a redraw — which read as the recording being thrown away.
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
      " p.hiddenPanels = []; localStorage.setItem(k, JSON.stringify(p));" +
      ' location.reload(); return 1 })()'
  )
  await new Promise((r) => setTimeout(r, 2600))

  const R = await win.webContents.executeJavaScript(String.raw`(async () => {
    const ed = window.editor;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms || 60));
    const R = {};

    const open = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').trim().toLowerCase().startsWith('full screen'));
    R.foundOpenButton = !!open;
    if (!open) return R;
    open.click();
    await wait(150);

    R.stageMounted = !!document.querySelector('.pstage');
    R.profilingOnEntry = ed.profiling === true;
    R.hookOnEntry = typeof ed.onProfileSample === 'function';

    // The stage must not swallow the pen: the canvas underneath is where both input paths
    // already meet, so it has to stay the thing hit-testing finds.
    const midX = Math.round(window.innerWidth * 0.55);
    const midY = Math.round(window.innerHeight * 0.6);
    const hit = document.elementFromPoint(midX, midY);
    R.penReachesCanvas = !!hit && hit.id === 'view';
    R.whatIsOnTop = hit ? hit.tagName + '#' + hit.id + '.' + String(hit.className).slice(0, 40) : 'nothing';
    R.stagePointerEvents = getComputedStyle(document.querySelector('.pstage')).pointerEvents;
    R.canvasPointerEvents = getComputedStyle(document.querySelector('.pstage-canvas')).pointerEvents;

    // Pick a test by clicking it, which is where the trail hook used to be destroyed.
    const tests = Array.from(document.querySelectorAll('.pstage-test'));
    R.testCount = tests.length;
    const pick = tests.find((b) => b.textContent.indexOf('Horizontal, slow') >= 0);
    R.foundTestButton = !!pick;
    if (!pick) return R;
    pick.click();
    await wait(150);
    R.selectedAfterClick =
      (document.querySelector('.pstage-test[aria-selected="true"]') || {}).textContent || '';
    R.profilingAfterPick = ed.profiling === true;
    R.hookAfterPick = typeof ed.onProfileSample === 'function';
    R.labelAfterPick = ed.recorder.label;

    // Draw, with the pen landing wherever hit-testing sends it.
    ed.recorder.clear();
    const cv = document.getElementById('view');
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    const inkBefore = ed.strokesCommitted;
    const y = midY;
    const x0 = Math.round(window.innerWidth * 0.35);
    const ev = (type, x) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: 12, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1
    }));
    ev('pointerdown', x0);
    await wait(20);
    let liveSeen = 0;
    for (let i = 1; i <= 24; i++) {
      ev('pointermove', x0 + i * 14);
      await wait(10);
      const live = document.querySelector('.pstage-live');
      if (live) liveSeen = Math.max(liveSeen, parseInt(live.textContent.replace(/\D/g, ''), 10) || 0);
    }
    ev('pointerup', x0 + 24 * 14);
    await wait(120);

    R.liveCounterShowed = liveSeen;
    R.laidNoInk = ed.strokesCommitted === inkBefore;
    R.captured = ed.recorder.count;
    R.samples = ed.recorder.lastSampleCount;

    // Without clicking anything else: is the row there, and are the numbers shown?
    R.rowAppeared = document.querySelectorAll('.pstage-list .prof-row').length;
    R.reportAppeared = !!document.querySelector('.prof-report');
    R.reportMentionsWobble = (document.querySelector('.prof-report') || { textContent: '' })
      .textContent.indexOf('Wobble') >= 0;

    // And the trail: real pixels on the stage canvas. The fade loop runs on animation
    // frames, which a window that is never shown delivers slowly, so this waits.
    const stageCanvas = document.querySelector('.pstage-canvas');
    let lit = 0;
    for (let attempt = 0; attempt < 40 && lit === 0; attempt++) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      const ctx = stageCanvas.getContext('2d');
      if (stageCanvas.width > 0) {
        const d = ctx.getImageData(0, 0, stageCanvas.width, stageCanvas.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++;
      }
    }
    R.trailPixels = lit;

    // Leaving must hand the pen back.
    const done = Array.from(document.querySelectorAll('.pstage-ui button'))
      .find((b) => b.textContent.trim() === 'Done');
    R.foundDone = !!done;
    if (done) {
      done.click();
      await wait(150);
      R.stageGoneAfterDone = !document.querySelector('.pstage');
      R.profilingOffAfterDone = ed.profiling === false;
    }
    return R;
  })()`)

  const fail = []
  const ok = (name, cond, detail) => {
    if (!cond) fail.push(name + ' — ' + detail)
  }

  ok('the full screen button exists', R.foundOpenButton === true, 'not found')
  ok('the stage opens', R.stageMounted === true, 'did not mount')
  ok('entering takes over the pen', R.profilingOnEntry === true, 'not profiling')
  ok('entering installs the trail', R.hookOnEntry === true, 'no trail hook')
  ok('the stage lets the pen reach the canvas', R.penReachesCanvas === true,
    'hit-testing found something else')
  ok('the tests are all listed', R.testCount === 11, R.testCount + ' tests')
  ok('picking a test selects it', String(R.selectedAfterClick).indexOf('Horizontal') >= 0,
    'selected ' + R.selectedAfterClick)
  ok('picking a test keeps the pen taken over', R.profilingAfterPick === true, 'not profiling')
  ok('picking a test keeps the trail alive', R.hookAfterPick === true,
    'the trail hook was torn down')
  ok('picking a test sets the label', R.labelAfterPick === 'h-slow', 'label ' + R.labelAfterPick)
  ok('drawing lays no ink', R.laidNoInk === true, 'it painted')
  ok('drawing records', R.captured === 1, R.captured + ' captures')
  ok('drawing records every sample', R.samples === 25, R.samples + ' samples')
  ok('the counter runs while drawing', R.liveCounterShowed > 5,
    'highest count shown was ' + R.liveCounterShowed)
  ok('the trail is actually drawn', R.trailPixels > 50, R.trailPixels + ' lit pixels')
  ok('the recording appears with no further clicks', R.rowAppeared === 1,
    R.rowAppeared + ' rows')
  ok('the numbers appear with no further clicks', R.reportAppeared === true, 'no report')
  ok('the numbers are the right ones', R.reportMentionsWobble === true,
    'report did not mention wobble')
  ok('Done closes the stage', R.stageGoneAfterDone === true, 'still open')
  ok('Done hands the pen back', R.profilingOffAfterDone === true, 'still profiling')

  if (errors.length) fail.push('console errors — ' + errors.slice(0, 3).join(' | '))

  console.log(JSON.stringify(R, null, 1))
  if (fail.length) {
    console.error('stage FAILED:')
    console.error('  ' + fail.join('\n  '))
    app.exit(1)
  } else {
    console.log('')
    console.log('stage: 20/20 — records, draws a trail, and shows the result unprompted')
    app.exit(0)
  }
})
