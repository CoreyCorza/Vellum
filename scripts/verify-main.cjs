/**
 * Engine behaviour checks, run inside the real Electron renderer against the
 * production bundle. These assert the things that are easy to get subtly wrong
 * and hard to notice by eye:
 *
 *   · undo/redo round-trips to the exact pixel
 *   · undo still targets the right layer after you switch layers
 *   · compositing respects stack order and blend modes
 *   · symmetry mirrors about the document centre
 *   · a stroke's history cost is its bounding box, not the whole canvas
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

  // level 3 = error. Warnings are excluded on purpose: this script's own
  // pixel-counting helper hammers getImageData, which makes Chromium suggest
  // willReadFrequently. That flag is deliberately OFF (see Surface) — it forces
  // a software backing store, and we blit far more often than we read back.
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(String.raw`(async () => {
    const ed = window.editor;
    if (!ed) return { failed: true, reason: 'no editor handle' };
    const R = {};

    const sp = (x, y, p) => ({ x, y, pressure: p, tilt: 0, twist: 0, t: performance.now() });
    const stroke = (pts, erase = false) => {
      ed.beginStroke(sp(pts[0][0], pts[0][1], pts[0][2]), erase);
      for (let i = 1; i < pts.length; i++) ed.extendStroke(sp(pts[i][0], pts[i][1], pts[i][2]));
      ed.endStroke();
    };
    const line = (x0, y0, x1, y1, n = 120, p = 1) => {
      const a = [];
      for (let i = 0; i <= n; i++) { const t = i / n; a.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p]); }
      return a;
    };
    // count non-background pixels on a specific layer
    const inkOf = (layer) => {
      const d = layer.surface.ctx.getImageData(0, 0, ed.doc.width, ed.doc.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 64) if (d[i] > 8) n++;
      return n;
    };
    const px = (surface, x, y) => surface.sample(x, y);

    // ---- start from a clean, known state -------------------------------
    while (ed.doc.layers.length > 1) ed.doc.removeLayer(ed.doc.layers.length - 1);
    ed.doc.activeIndex = 0;
    ed.doc.layers[0].surface.clear();
    ed.history.clear();
    ed.compositor.invalidate();
    ed.setBrush({ size: 40, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.05,
                  pressureToSize: false, pressureToOpacity: false, stabilise: 0,
                  color: '#ff0000', symmetry: 'none' });

    // ---- 1. paint + undo/redo round trip -------------------------------
    stroke(line(300, 300, 1700, 300));
    const painted = inkOf(ed.doc.layers[0]);
    ed.undo();
    const afterUndo = inkOf(ed.doc.layers[0]);
    ed.redo();
    const afterRedo = inkOf(ed.doc.layers[0]);
    R.undoRoundTrip = { painted, afterUndo, afterRedo,
                        exact: painted === afterRedo && afterUndo === 0 };

    // ---- 2. undo targets the ORIGINATING layer, not the active one -----
    ed.addLayer();
    ed.setBrush({ color: '#0000ff' });
    stroke(line(300, 700, 1700, 700));
    const l0Before = inkOf(ed.doc.layers[0]);
    const l1Before = inkOf(ed.doc.layers[1]);
    ed.selectLayer(0);            // switch away, THEN undo
    ed.undo();
    R.undoAcrossLayers = {
      layer0Unchanged: inkOf(ed.doc.layers[0]) === l0Before,
      layer1Cleared: inkOf(ed.doc.layers[1]) === 0,
      hadInk: l1Before > 0
    };
    ed.redo();

    // ---- 3. stack order: the top layer wins -----------------------------
    ed.selectLayer(0);
    ed.doc.layers[0].surface.fill('#ff0000');
    ed.doc.layers[1].surface.fill('#00ff00');
    ed.compositor.invalidate();
    let comp = ed.compositor.composite(ed.doc, null, 1, 'source-over');
    R.stackOrder = { topWins: px(comp, 1000, 700).slice(0, 3).join() === '0,255,0' };

    // ---- 4. blend mode actually applies --------------------------------
    ed.setLayerProps(1, { blend: 'multiply' });
    comp = ed.compositor.composite(ed.doc, null, 1, 'source-over');
    const mult = px(comp, 1000, 700).slice(0, 3);
    R.blendMode = { rgb: mult.join(), multiplyIsBlack: mult[0] === 0 && mult[1] === 0 };
    ed.setLayerProps(1, { blend: 'normal' });

    // ---- 5. hidden layer is excluded ------------------------------------
    ed.setLayerProps(1, { visible: false });
    comp = ed.compositor.composite(ed.doc, null, 1, 'source-over');
    R.visibility = { hiddenExcluded: px(comp, 1000, 700).slice(0, 3).join() === '255,0,0' };
    ed.setLayerProps(1, { visible: true });

    // ---- 6. symmetry mirrors about the document centre -------------------
    ed.doc.layers[1].surface.clear();
    ed.selectLayer(1);
    ed.setBrush({ color: '#000000', symmetry: 'x', size: 60 });
    stroke(line(400, 400, 400, 900, 60));
    const leftHit  = px(ed.doc.layers[1].surface, 400, 650)[3] > 8;
    const rightHit = px(ed.doc.layers[1].surface, ed.doc.width - 400, 650)[3] > 8;
    R.symmetry = { leftHit, rightHit, mirrored: leftHit && rightHit };
    ed.setBrush({ symmetry: 'none' });

    // ---- 7. eraser removes and undoes exactly ---------------------------
    ed.doc.layers[1].surface.fill('#000000');
    const solid = inkOf(ed.doc.layers[1]);
    ed.history.clear();
    ed.setBrush({ size: 120 });
    stroke(line(200, 500, 1800, 500), true);
    const erased = inkOf(ed.doc.layers[1]);
    ed.undo();
    R.eraser = { solid, erased, removedPixels: erased < solid,
                 undoExact: inkOf(ed.doc.layers[1]) === solid };

    // ---- 8. history cost is the bounding box, not the canvas ------------
    ed.history.clear();
    ed.setBrush({ size: 20 });
    stroke(line(100, 100, 300, 120, 40));
    const fullCanvas = ed.doc.width * ed.doc.height * 4;
    R.historyCost = {
      bytes: ed.history.retainedBytes,
      fullCanvasBytes: fullCanvas,
      ratio: +(ed.history.retainedBytes / fullCanvas).toFixed(4)
    };

    // ---- 9. per-stroke overhead ------------------------------------------
    // The commit path does one full-canvas GPU copy (backup) plus one
    // bounding-box readback. If that ever shows up as a hitch at stroke start,
    // this is the number that says so.
    ed.history.clear();
    ed.setBrush({ size: 30 });
    const t0 = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) stroke(line(200, 200 + i * 40, 1800, 240 + i * 40, 200));
    const perStroke = (performance.now() - t0) / N;
    R.strokeCostMs = +perStroke.toFixed(2);

    // Isolate the two synchronous chunks. A stall at pen-down is felt
    // immediately; the same milliseconds spread across a stroke are not.
    let beginMs = 0, endMs = 0;
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      ed.beginStroke(sp(300, 300 + i, 1), false);
      const b = performance.now();
      for (let j = 1; j < 60; j++) ed.extendStroke(sp(300 + j * 20, 300 + i, 1));
      const c = performance.now();
      ed.endStroke();
      const d = performance.now();
      beginMs += b - a; endMs += d - c;
    }
    R.penDownMs = +(beginMs / N).toFixed(2);
    R.penUpMs = +(endMs / N).toFixed(2);

    R.failed = !(
      R.undoRoundTrip.exact &&
      R.undoAcrossLayers.layer0Unchanged && R.undoAcrossLayers.layer1Cleared && R.undoAcrossLayers.hadInk &&
      R.stackOrder.topWins &&
      R.blendMode.multiplyIsBlack &&
      R.visibility.hiddenExcluded &&
      R.symmetry.mirrored &&
      R.eraser.removedPixels && R.eraser.undoExact &&
      R.historyCost.ratio < 0.05 &&
      R.strokeCostMs < 60
    );
    return R;
  })()`)

  result.consoleErrors = errors
  if (errors.length > 0) result.failed = true

  console.log('VERIFY_RESULT ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
