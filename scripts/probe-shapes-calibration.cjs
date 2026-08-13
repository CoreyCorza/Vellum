/**
 * PARKED EXPERIMENT — does not currently work. Kept for the record, not in the verify chain.
 *
 * The idea is sound and worth returning to: a person draws lines, C curves and S curves, a stiff
 * curve is fitted through each stroke as what was intended, and the leftover is the tablet. No ruler,
 * no placement, and a curve sweeps through many directions so one S curve does the work of several
 * ruler angles. The turning measurement works, the curve fitting works to 0.065 px on an aggressive
 * S, and the geometry is right.
 *
 * What defeats it: the fitted curve removes the hand, which is the point, but it removes most of the
 * distortion with it, because a stiff curve and a slow warp look alike. What survives is about 0.1 px
 * of signal against noise of the same size, and the joint fit cannot separate the two axes from it —
 * results get WORSE as strokes are added, which is the signature of an estimator being handed noise.
 *
 * A ruler works because it constrains the hand physically rather than mathematically, so nothing has
 * to be subtracted and the full distortion survives to be measured.
 *
 * Ideas worth trying before this is revived: ask for strokes drawn along a screen edge or a window
 * frame; use the crossings of many strokes against each other rather than any single intended shape;
 * or keep the hand in and lean entirely on volume, with hundreds of strokes rather than tens.
 *
 * Can a tablet be measured from ordinary drawn strokes, with no ruler?
 *
 * If this works the whole calibration changes shape: no physical object, no careful placement, no
 * asking someone to own a straightedge — just draw some lines and curves the way you normally would.
 *
 * A fictional digitiser is given a distortion. Simulated strokes are drawn across it: straight
 * lines, C curves and S curves, each with a hand that wanders differently every time and a slightly
 * different intended shape. Nothing knows what any stroke was meant to be — the fit works that out
 * by putting a stiff curve through it.
 *
 * The claim being tested is specifically that CURVATURE replaces the ruler's several careful angles.
 * A curve sweeps through many directions along its length, and sideways error is a different mixture
 * of the two axes at every direction, so one S curve should do the work of several ruler placements.
 * That is checked directly: a set of curves drawn in one general direction should still calibrate,
 * where a set of straight lines all the same way round cannot.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 2000))

  const R = await win.webContents.executeJavaScript(String.raw`(() => {
    const d = window.diag;
    if (!d || !d.calibrateFromShapes) return { failed: true, reason: 'calibrateFromShapes not exposed' };

    const exTrue = (x) => 0.30 * Math.sin((2 * Math.PI * x) / 40);
    const eyTrue = (y) => 0.24 * Math.sin((2 * Math.PI * y) / 52 + 2.1);

    const rng = (seed) => { let s = seed; return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };

    /**
     * One drawn stroke. 'line', 'c' or 's', with a hand on it.
     *
     * The intended shape is a quadratic or cubic through three or four control points, which is what
     * an arm drawing a line or a sweeping curve actually produces. The hand rides on top as a few
     * slow waves, different every stroke, several times the size of the distortion.
     */
    const stroke = (opts) => {
      const r = rng(opts.seed);
      const waves = [];
      for (let k = 0; k < 4; k++) waves.push({ a: 0.4 + r() * 0.8, ph: r() * 6.283, per: 150 + r() * 600 });
      const hand = (t) => waves.reduce((s, w) => s + w.a * Math.sin((2 * Math.PI * t) / w.per + w.ph), 0);

      const a = opts.angle;
      const L = opts.length;
      const ux = Math.cos(a), uy = Math.sin(a);
      const nx = -uy, ny = ux;
      const bend = opts.bend;
      const raw = [];
      const n = 700;
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        const s = f * L;
        // The intended shape, as an offset sideways from a straight run.
        let shape = 0;
        if (opts.kind === 'c') shape = bend * Math.sin(Math.PI * f);
        else if (opts.kind === 's') shape = bend * Math.sin(2 * Math.PI * f);
        const across = shape + hand(s) * 0.4;
        const trueX = opts.x0 + ux * s + nx * across;
        const trueY = opts.y0 + uy * s + ny * across;
        raw.push({
          t: i * 3, x: trueX + exTrue(trueX), y: trueY + eyTrue(trueY),
          pressure: 0.5, tilt: 0, twist: 0
        });
      }
      return {
        version: 1, label: 'free', startedAt: 0, viewScale: 1, viewX: 0, viewY: 0,
        devicePixelRatio: 1, source: 'synthetic', raw: raw, drawn: []
      };
    };

    const deg = (v) => (v * Math.PI) / 180;
    const R = {};

    // How much does one stroke turn? A line barely at all, an S curve a great deal.
    const spreadOf = (c) => d.directionSpread(d.shapeResiduals(c.raw));
    R.spreadLine = spreadOf(stroke({ kind: 'line', angle: deg(30), x0: -600, y0: -300, length: 1400, bend: 0, seed: 5 }));
    R.spreadC = spreadOf(stroke({ kind: 'c', angle: deg(30), x0: -600, y0: -300, length: 1400, bend: 260, seed: 5 }));
    R.spreadS = spreadOf(stroke({ kind: 's', angle: deg(30), x0: -600, y0: -300, length: 1400, bend: 260, seed: 5 }));

    // A realistic minute of drawing: twenty strokes, mixed shapes, all over the surface.
    const kinds = ['line', 'c', 's', 'c', 's', 'line', 's', 'c', 's', 'line'];
    const natural = [];
    for (let i = 0; i < 20; i++) {
      natural.push(stroke({
        kind: kinds[i % kinds.length],
        angle: deg(-80 + i * 9),
        x0: -700 + (i % 5) * 130, y0: -600 + (i % 4) * 170,
        length: 1200 + (i % 3) * 250,
        bend: (i % 2 ? 1 : -1) * (120 + (i % 4) * 70),
        seed: 101 + i * 37
      }));
    }
    const res = d.calibrateFromShapes(natural);
    R.strokes = res.sweeps;
    R.verdict = res.verdict;
    R.heldOut = res.heldOut;
    R.onFit = res.onFit;
    R.control = res.control;

    // Does the recovered ripple match the real one?
    if (res.correction && res.correction.x) {
      const t = res.correction.x;
      const want = [], got = [];
      for (let i = 0; i < t.offsets.length; i++) {
        if (t.weight[i] < 8) continue;
        want.push(exTrue(t.origin + i * t.step));
        got.push(t.offsets[i]);
      }
      const hp = (v, h) => v.map(function (x, i) {
        const a = Math.max(0, i - h), b = Math.min(v.length - 1, i + h);
        let m = 0;
        for (let k = a; k <= b; k++) m += v[k];
        return x - m / (b - a + 1);
      });
      const A = hp(want, 15), B = hp(got, 15);
      let ma = 0, mb = 0;
      for (let i = 0; i < A.length; i++) { ma += A[i]; mb += B[i]; }
      ma /= A.length; mb /= B.length;
      let sab = 0, saa = 0, sbb = 0;
      for (let i = 0; i < A.length; i++) {
        sab += (A[i] - ma) * (B[i] - mb);
        saa += (A[i] - ma) * (A[i] - ma);
        sbb += (B[i] - mb) * (B[i] - mb);
      }
      R.shapeMatch = sab / Math.sqrt(Math.max(1e-30, saa * sbb));
    }

    // The claim: curves in ONE general direction still work, because they turn.
    const curvesOneWay = [];
    for (let i = 0; i < 14; i++) {
      curvesOneWay.push(stroke({
        kind: i % 2 ? 's' : 'c', angle: deg(28 + (i % 3)),
        x0: -650 + (i % 5) * 120, y0: -550 + (i % 4) * 160,
        length: 1300, bend: (i % 2 ? 1 : -1) * 240, seed: 501 + i * 29
      }));
    }
    const curved = d.calibrateFromShapes(curvesOneWay);
    R.curvesOneWayVerdict = curved.verdict;
    R.curvesOneWayHeldOut = curved.heldOut;
    R.curvesOneWayControl = curved.control;

    // The contrast: straight lines all the same way round cannot separate the axes, and must be
    // refused rather than quietly producing a table that is half of one axis mixed into the other.
    const linesOneWay = [];
    for (let i = 0; i < 14; i++) {
      linesOneWay.push(stroke({
        kind: 'line', angle: deg(28 + (i % 3)),
        x0: -650 + (i % 5) * 120, y0: -550 + (i % 4) * 160,
        length: 1300, bend: 0, seed: 701 + i * 29
      }));
    }
    const flat = d.calibrateFromShapes(linesOneWay);
    R.linesOneWayVerdict = flat.verdict;
    R.linesOneWayGaveTable = flat.correction !== null;

    // And too few strokes.
    const few = d.calibrateFromShapes(natural.slice(0, 3));
    R.fewVerdict = few.verdict;

    return R;
  })()`)

  if (R.failed) {
    console.error('shapes: ' + R.reason)
    app.exit(1)
    return
  }

  const fail = []
  const ok = (name, cond, detail) => {
    if (!cond) fail.push(name + ' — ' + detail)
  }
  const pct = (v) => (v * 100).toFixed(1) + '%'

  ok('a straight line barely turns', R.spreadLine < 12, R.spreadLine.toFixed(1) + ' degrees')
  ok('a C curve turns', R.spreadC > 30, R.spreadC.toFixed(1) + ' degrees')
  ok('an S curve turns more', R.spreadS > R.spreadC, R.spreadS.toFixed(1) + ' degrees')

  ok('twenty ordinary strokes calibrate', R.verdict === 'good', 'said ' + R.verdict)
  ok('and remove wobble from strokes not used', R.heldOut > 0.25, pct(R.heldOut))
  ok('clearly beating the wrong-axis control', R.heldOut > R.control + 0.2,
    pct(R.heldOut) + ' against ' + pct(R.control))
  ok('the recovered ripple matches the real one', R.shapeMatch > 0.6,
    'correlation ' + (R.shapeMatch === undefined ? 'none' : R.shapeMatch.toFixed(3)))

  ok('curves drawn in one direction still work', R.curvesOneWayVerdict !== 'not enough data',
    'said ' + R.curvesOneWayVerdict + ' at ' + pct(R.curvesOneWayHeldOut))
  ok('because turning is what separates the axes',
    R.curvesOneWayHeldOut > R.curvesOneWayControl + 0.15,
    pct(R.curvesOneWayHeldOut) + ' against ' + pct(R.curvesOneWayControl))
  ok('straight lines all one way are refused', R.linesOneWayVerdict === 'not enough data',
    'said ' + R.linesOneWayVerdict)
  ok('and produce no table', R.linesOneWayGaveTable === false, 'it produced one')
  ok('too few strokes are refused', R.fewVerdict === 'not enough data', 'said ' + R.fewVerdict)

  if (errors.length) fail.push('console errors — ' + errors.slice(0, 3).join(' | '))

  console.log(
    JSON.stringify(
      {
        turning: {
          line: +R.spreadLine.toFixed(1), c: +R.spreadC.toFixed(1), s: +R.spreadS.toFixed(1)
        },
        twentyStrokes: {
          used: R.strokes, onFit: pct(R.onFit), heldOut: pct(R.heldOut), control: pct(R.control),
          rippleMatch: R.shapeMatch === undefined ? null : +R.shapeMatch.toFixed(3),
          verdict: R.verdict
        },
        curvesOneDirection: {
          verdict: R.curvesOneWayVerdict, heldOut: pct(R.curvesOneWayHeldOut),
          control: pct(R.curvesOneWayControl)
        },
        linesOneDirection: R.linesOneWayVerdict
      },
      null,
      1
    )
  )

  if (fail.length) {
    console.error('shapes FAILED:')
    console.error('  ' + fail.join('\n  '))
    app.exit(1)
  } else {
    console.log('')
    console.log('shapes: 12/12 — a tablet can be measured from ordinary strokes, no ruler needed')
    app.exit(0)
  }
})
