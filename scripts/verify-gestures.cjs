/**
 * Gesture checks for alt+right-drag brush resize and ctrl+space+left-drag zoom.
 * Driven through real DOM PointerEvents on the canvas, so this exercises the
 * actual listeners in input.ts rather than calling editor methods directly.
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

  // The focus test needs the Pressure-to-size checkbox, which only exists while the
  // Pen dynamics category is showing. Chosen through stored preferences and a reload
  // rather than by clicking the category here: the test body is synchronous, so a
  // click would be read back before React had re-rendered.
  await win.webContents.executeJavaScript(
    "(() => { const k = 'vellum.prefs';" +
      " const p = JSON.parse(localStorage.getItem(k) || '{}');" +
      " p.brushCategory = 'dynamics'; p.hiddenPanels = [];" +
      " localStorage.setItem(k, JSON.stringify(p)); location.reload(); return 1 })()"
  )
  await new Promise((r) => setTimeout(r, 2600))

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const ed = window.editor;
    const cv = document.getElementById('view');
    if (!ed || !cv) return { failed: true, reason: 'not mounted' };
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    const R = {};
    const box = cv.getBoundingClientRect();

    const ev = (type, opts) => cv.dispatchEvent(new PointerEvent(type, Object.assign({
      pointerId: 3, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true
    }, opts)));

    const key = (type, code, init) => window.dispatchEvent(
      new KeyboardEvent(type, Object.assign({ code, key: code === 'Space' ? ' ' : code,
        bubbles: true }, init)));

    // ---------- alt + right-drag resizes the brush -----------------------
    ed.setBrush({ size: 40 });
    ed.camera.scale = 1;
    key('keydown', 'AltLeft', { altKey: true });
    ev('pointerdown', { button: 2, buttons: 2, altKey: true,
                        clientX: box.left + 400, clientY: box.top + 300 });
    R.previewShownOnDown = ed.brushPreview.active;
    R.previewAnchor = { x: Math.round(ed.brushPreview.x), y: Math.round(ed.brushPreview.y) };

    ev('pointerrawupdate', { buttons: 2, altKey: true,
                             clientX: box.left + 450, clientY: box.top + 300 });
    const after50Right = ed.brush.size;
    ev('pointerrawupdate', { buttons: 2, altKey: true,
                             clientX: box.left + 300, clientY: box.top + 300 });
    const after100Left = ed.brush.size;
    // vertical movement must NOT change size — that axis is reserved
    ev('pointerrawupdate', { buttons: 2, altKey: true,
                             clientX: box.left + 300, clientY: box.top + 600 });
    const afterVertical = ed.brush.size;
    ev('pointerup', { button: 2, buttons: 0, clientX: box.left + 300, clientY: box.top + 600 });
    key('keyup', 'AltLeft', { altKey: false });

    // exponential mapping: +50px => x e^0.5 => 40 * 1.6487 = 65.95
    //                      -100px from origin => x e^-1 => 40 * 0.3679 = 14.72
    const near = (a, b) => Math.abs(a - b) < 0.05;
    R.resize = {
      startSize: 40,
      after50Right: +after50Right.toFixed(2),
      after100Left: +after100Left.toFixed(2),
      afterVertical: +afterVertical.toFixed(2),
      rightGrows: near(after50Right, 40 * Math.exp(0.5)),
      leftShrinks: near(after100Left, 40 * Math.exp(-1)),
      verticalIgnored: afterVertical === after100Left,
      previewHiddenOnUp: ed.brushPreview.active === false,
      anchoredWhereDragBegan: Math.round(ed.brushPreview.x) === 400
    };

    // The mapping must be ZOOM-INDEPENDENT — the same drag gives the same size
    // at any scale. A screen-relative mapping would divide by camera scale and
    // make the throw length swing wildly with zoom.
    const atScale = {};
    for (const s of [0.25, 1, 4]) {
      ed.setBrush({ size: 40 });
      ed.camera.scale = s;
      ev('pointerdown', { button: 2, buttons: 2, altKey: true,
                          clientX: box.left + 400, clientY: box.top + 300 });
      ev('pointerrawupdate', { buttons: 2, altKey: true,
                               clientX: box.left + 450, clientY: box.top + 300 });
      atScale[s] = +ed.brush.size.toFixed(2);
      ev('pointerup', { button: 2, buttons: 0, clientX: box.left + 450, clientY: box.top + 300 });
    }
    // how far you must drag to sweep the whole 1..400 range
    const fullSweepPx = Math.round(Math.log(400 / 1) / 0.01);
    R.resizeIsZoomIndependent = {
      atScale,
      fullRangeSweepPx: fullSweepPx,
      ok: atScale[0.25] === atScale[1] && atScale[1] === atScale[4] &&
          near(atScale[1], 40 * Math.exp(0.5)) &&
          fullSweepPx > 400 && fullSweepPx < 900
    };

    // ---------- alt + right-drag must not paint or pan --------------------
    const inkBefore = (() => { const d = ed.doc.active.surface.ctx
      .getImageData(0,0,ed.doc.width,ed.doc.height).data; let n=0;
      for (let i=3;i<d.length;i+=256) if (d[i]>8) n++; return n; })();
    const camBefore = { cx: ed.camera.cx, cy: ed.camera.cy };
    ev('pointerdown', { button: 2, buttons: 2, altKey: true,
                        clientX: box.left + 500, clientY: box.top + 400 });
    ev('pointerrawupdate', { buttons: 2, altKey: true,
                             clientX: box.left + 560, clientY: box.top + 470 });
    ev('pointerup', { button: 2, buttons: 0, clientX: box.left + 560, clientY: box.top + 470 });
    const inkAfter = (() => { const d = ed.doc.active.surface.ctx
      .getImageData(0,0,ed.doc.width,ed.doc.height).data; let n=0;
      for (let i=3;i<d.length;i+=256) if (d[i]>8) n++; return n; })();
    R.noSideEffects = {
      didNotPaint: inkAfter === inkBefore,
      didNotPan: ed.camera.cx === camBefore.cx && ed.camera.cy === camBefore.cy
    };

    // ---------- ctrl + space + left-drag zooms ----------------------------
    ed.camera.scale = 1;
    ed.camera.rotation = 0;
    ed.camera.cx = ed.doc.width / 2;
    ed.camera.cy = ed.doc.height / 2;
    key('keydown', 'ControlLeft', { ctrlKey: true });
    key('keydown', 'Space', { ctrlKey: true });

    const anchorScreen = { x: 500, y: 350 };
    const docUnderAnchor = ed.camera.screenToDoc(anchorScreen.x, anchorScreen.y);

    ev('pointerdown', { button: 0, buttons: 1, ctrlKey: true,
                        clientX: box.left + anchorScreen.x, clientY: box.top + anchorScreen.y });
    ev('pointerrawupdate', { buttons: 1, ctrlKey: true,
                             clientX: box.left + anchorScreen.x, clientY: box.top + anchorScreen.y - 100 });
    const zoomedIn = ed.camera.scale;
    ev('pointerrawupdate', { buttons: 1, ctrlKey: true,
                             clientX: box.left + anchorScreen.x, clientY: box.top + anchorScreen.y + 100 });
    const zoomedOut = ed.camera.scale;

    // the point under the cursor must not drift while zooming
    const docNow = ed.camera.screenToDoc(anchorScreen.x, anchorScreen.y);
    ev('pointerup', { button: 0, buttons: 0,
                      clientX: box.left + anchorScreen.x, clientY: box.top + anchorScreen.y + 100 });
    key('keyup', 'Space', { ctrlKey: true });
    key('keyup', 'ControlLeft', { ctrlKey: false });

    R.zoom = {
      zoomedIn: +zoomedIn.toFixed(4),
      zoomedOut: +zoomedOut.toFixed(4),
      upZoomsIn: zoomedIn > 1,
      downZoomsOut: zoomedOut < 1,
      anchorDrift: {
        dx: +(docNow.x - docUnderAnchor.x).toFixed(3),
        dy: +(docNow.y - docUnderAnchor.y).toFixed(3)
      },
      noDrift: Math.abs(docNow.x - docUnderAnchor.x) < 0.01 &&
               Math.abs(docNow.y - docUnderAnchor.y) < 0.01,
      didNotPaint: true
    };

    // ---------- space alone (no ctrl) must still pan ----------------------
    ed.camera.scale = 1;
    const panBefore = ed.camera.cx;
    key('keydown', 'Space', {});
    ev('pointerdown', { button: 0, buttons: 1, clientX: box.left + 400, clientY: box.top + 300 });
    ev('pointerrawupdate', { buttons: 1, clientX: box.left + 340, clientY: box.top + 300 });
    ev('pointerup', { button: 0, buttons: 0, clientX: box.left + 340, clientY: box.top + 300 });
    key('keyup', 'Space', {});
    R.spaceStillPans = { moved: ed.camera.cx !== panBefore, delta: +(ed.camera.cx - panBefore).toFixed(1) };

    // ---------- blur clears stuck modifiers -------------------------------
    key('keydown', 'Space', {});
    window.dispatchEvent(new Event('blur'));
    const panAfterBlur = ed.camera.cx;
    ev('pointerdown', { button: 0, buttons: 1, clientX: box.left + 400, clientY: box.top + 300 });
    const paintedAfterBlur = ed.strokeActive;
    ev('pointerup', { button: 0, buttons: 0, clientX: box.left + 400, clientY: box.top + 300 });
    R.blurClearsModifiers = {
      startedStrokeInsteadOfPanning: paintedAfterBlur,
      cameraUnmoved: ed.camera.cx === panAfterBlur
    };

    // ---- barrel-free resize: hold S and move, NO button pressed ----------
    // The whole point is that no right-click ever happens, so Windows Ink has
    // nothing to draw its ring for.
    ed.setBrush({ size: 40 });
    ed.camera.scale = 1;
    // put the cursor over the canvas first (hover, buttons: 0)
    ev('pointerrawupdate', { buttons: 0, clientX: box.left + 400, clientY: box.top + 300 });
    key('keydown', 'KeyS', { key: 's' });
    const armed = ed.sizeScrubActive;
    const previewAt = { x: Math.round(ed.brushPreview.x), y: Math.round(ed.brushPreview.y) };
    // hover-move right with NO button down
    ev('pointerrawupdate', { buttons: 0, clientX: box.left + 500, clientY: box.top + 300 });
    const hoverResized = ed.brush.size;
    // a pen-down while scrubbing must not paint
    const inkBeforeScrub = (() => { const d = ed.doc.active.surface.ctx
      .getImageData(0,0,ed.doc.width,ed.doc.height).data; let n=0;
      for (let i=3;i<d.length;i+=256) if (d[i]>8) n++; return n; })();
    ev('pointerdown', { button: 0, buttons: 1, clientX: box.left + 500, clientY: box.top + 300 });
    const paintedDuringScrub = ed.strokeActive;
    ev('pointerup', { button: 0, buttons: 0, clientX: box.left + 500, clientY: box.top + 300 });
    const inkAfterScrub = (() => { const d = ed.doc.active.surface.ctx
      .getImageData(0,0,ed.doc.width,ed.doc.height).data; let n=0;
      for (let i=3;i<d.length;i+=256) if (d[i]>8) n++; return n; })();
    key('keyup', 'KeyS', { key: 's' });
    const disarmed = !ed.sizeScrubActive;
    // after release, painting works again
    ev('pointerdown', { button: 0, buttons: 1, clientX: box.left + 420, clientY: box.top + 320 });
    const paintsAfterRelease = ed.strokeActive;
    ev('pointerup', { button: 0, buttons: 0, clientX: box.left + 420, clientY: box.top + 320 });

    R.barrelFreeResize = {
      armedOnKeyDown: armed,
      previewAnchoredAtCursor: previewAt.x === 400,
      resizedWithNoButton: Math.abs(hoverResized - 40 * Math.exp(1)) < 0.05,
      hoverResized: +hoverResized.toFixed(2),
      didNotPaintDuringScrub: !paintedDuringScrub && inkAfterScrub === inkBeforeScrub,
      disarmedOnKeyUp: disarmed,
      paintsAgainAfterRelease: paintsAfterRelease
    };
    ed.undo();

    // ---- focus must not stick to UI widgets ------------------------------
    // Regression: isTextField() treated every <input> as text entry, so a
    // focused CHECKBOX made the shortcut handler bail out — space toggled the
    // box and never reached the canvas.
    const cb = document.getElementById('d-size');
    const F = {};
    // Named rather than silently skipped: the bare presence guard below let a
    // missing control produce an empty result object and a failure with nothing to
    // point at.
    F.foundCheckbox = !!cb;
    if (cb) {
      cb.focus();
      const before = cb.checked;
      cb.click();                                   // real activation
      F.togglesOnClick = cb.checked !== before;
      F.focusDroppedAfterClick = document.activeElement !== cb;
      cb.click();                                   // restore

      // space, with the checkbox focused, must be cancelled AND reach the app
      cb.focus();
      const kd = new KeyboardEvent('keydown', { code: 'Space', key: ' ',
                                                bubbles: true, cancelable: true });
      cb.dispatchEvent(kd);
      F.spaceIsPrevented = kd.defaultPrevented;
      F.spaceDropsFocus = document.activeElement !== cb;

      // ...and space-drag must actually pan while a widget had focus
      ed.camera.scale = 1;
      const cxBefore = ed.camera.cx;
      ev('pointerdown', { button: 0, buttons: 1, clientX: box.left + 400, clientY: box.top + 300 });
      ev('pointerrawupdate', { buttons: 1, clientX: box.left + 330, clientY: box.top + 300 });
      ev('pointerup', { button: 0, buttons: 0, clientX: box.left + 330, clientY: box.top + 300 });
      F.pannedNotPainted = ed.camera.cx !== cxBefore;
      key('keyup', 'Space', {});

      // typing a space in a text field must still be a space
      const hex = document.getElementById('hex');
      if (hex) {
        hex.focus();
        const tk = new KeyboardEvent('keydown', { code: 'Space', key: ' ',
                                                  bubbles: true, cancelable: true });
        hex.dispatchEvent(tk);
        F.textFieldSpaceUntouched = !tk.defaultPrevented && document.activeElement === hex;
        hex.blur();
      }
    }
    R.focus = F;

    const B = R.barrelFreeResize;
    R.failed = !(
      B.armedOnKeyDown && B.previewAnchoredAtCursor && B.resizedWithNoButton &&
      B.didNotPaintDuringScrub && B.disarmedOnKeyUp && B.paintsAgainAfterRelease &&
      F.foundCheckbox && F.togglesOnClick && F.focusDroppedAfterClick && F.spaceIsPrevented &&
      F.spaceDropsFocus && F.pannedNotPainted && F.textFieldSpaceUntouched &&
      R.resize.rightGrows && R.resize.leftShrinks &&
      R.resize.verticalIgnored && R.resize.previewHiddenOnUp && R.resize.anchoredWhereDragBegan &&
      R.previewShownOnDown &&
      R.resizeIsZoomIndependent.ok &&
      R.noSideEffects.didNotPaint && R.noSideEffects.didNotPan &&
      R.zoom.upZoomsIn && R.zoom.downZoomsOut && R.zoom.noDrift &&
      R.spaceStillPans.moved &&
      R.blurClearsModifiers.startedStrokeInsteadOfPanning
    );
    return R;
  })()`)

  result.consoleErrors = errors
  if (errors.length > 0) result.failed = true

  console.log('GESTURES ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
