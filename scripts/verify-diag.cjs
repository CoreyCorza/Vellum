/**
 * Does the tablet analyser measure what it claims to measure?
 *
 * Every check here feeds it a stroke built to order — a straight line with a wobble of
 * known size, at a known rate, at a known angle — and asks whether the numbers come back
 * out. Until that holds there is no point pointing it at a real tablet, because a wrong
 * analyser produces confident numbers exactly as readily as a right one, and the whole
 * argument for building this is that measurement beats squinting at strokes.
 *
 * The last group is the one that matters most: telling a wobble fixed in TIME (the
 * electronics) from one fixed in DISTANCE (the sensor grid), by drawing the same defect
 * at two speeds. That distinction decides what a fix would even look like, and it is the
 * one thing eyeballing a line can never tell you.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
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
  await new Promise((r) => setTimeout(r, 2000))

  const R = await win.webContents.executeJavaScript(String.raw`(() => {
    const d = window.diag;
    if (!d || !d.report) return { failed: true, reason: 'diag not exposed' };

    /**
     * A stroke to order. Travels at a given angle from the origin at a given speed in
     * px/ms, sampled at a fixed interval, with a sine wobble across the direction of
     * travel: either a fixed number of cycles per second, or a fixed number per pixel
     * travelled. No backticks in here — this whole function is inside a template string,
     * and one would end it early.
     */
    const make = (o) => {
      const angle = o.angle || 0;
      const speed = o.speed || 0.5;
      const dt = o.dt || 5;
      const n = o.n || 400;
      const amp = o.amp || 0;
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const nx = -uy, ny = ux;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const t = i * dt;
        const s = speed * t;
        const phase = o.perPixel != null
          ? 2 * Math.PI * s * o.perPixel
          : 2 * Math.PI * (o.hz || 0) * (t / 1000);
        const e = amp * Math.sin(phase) + (o.noise ? (Math.random() * 2 - 1) * o.noise : 0);
        pts.push({
          t: t, x: 100 + ux * s + nx * e, y: 100 + uy * s + ny * e,
          pressure: 0.5, tilt: 0, twist: 0
        });
      }
      return pts;
    };

    const R = {};
    const deg = (r) => (r * 180) / Math.PI;

    // 1. Does it find the line? Including vertical, which is where fitting y against x
    //    breaks down completely and why the fit is done by principal axis.
    for (const a of [0, 30, 45, 90, 135]) {
      const line = d.fitLine(make({ angle: (a * Math.PI) / 180, amp: 0.5, hz: 12 }));
      let found = deg(Math.atan2(line.dy, line.dx));
      if (found < -1) found += 180;
      R['angle' + a] = +Math.abs(found - a).toFixed(2);
    }

    // 2. Does it measure the size of a known wobble? A sine of amplitude A has an RMS of
    //    A/sqrt(2) and a peak of A.
    const known = make({ amp: 0.8, hz: 14, n: 600 });
    const dev = d.deviation(known);
    const sp = d.spread(dev.error);
    R.rmsWanted = +(0.8 / Math.SQRT2).toFixed(3);
    R.rmsFound = +sp.rms.toFixed(3);
    R.peakFound = +sp.peak.toFixed(3);

    // 3. Does it find the wobble's rate in time?
    const inTime = d.spectrum(dev.error, dev.t.map((ms) => ms / 1000)).peak;
    R.hzWanted = 14;
    R.hzFound = +inTime.frequency.toFixed(2);
    R.hzAmplitude = +inTime.amplitude.toFixed(3);
    R.hzProminence = Math.round(inTime.prominence);

    // 4. Broadband noise must NOT be reported as a periodic component, or every tablet
    //    looks like it has a resonance and a notch filter looks like the answer.
    const noisy = d.deviation(make({ amp: 0, noise: 0.6, n: 600 }));
    const noisePeak = d.spectrum(noisy.error, noisy.t.map((ms) => ms / 1000)).peak;
    R.noiseProminence = +noisePeak.prominence.toFixed(1);

    // 5. TIME versus DISTANCE. The same defect drawn at two speeds.
    //    A wobble fixed in time keeps its frequency and changes its spatial period.
    const slowT = d.deviation(make({ amp: 0.7, hz: 20, speed: 0.25, n: 700 }));
    const fastT = d.deviation(make({ amp: 0.7, hz: 20, speed: 0.75, n: 700 }));
    R.timeDefect = {
      slowHz: +d.spectrum(slowT.error, slowT.t.map((m) => m / 1000)).peak.frequency.toFixed(2),
      fastHz: +d.spectrum(fastT.error, fastT.t.map((m) => m / 1000)).peak.frequency.toFixed(2),
      slowPeriodPx: +d.spectrum(slowT.error, slowT.travelled).peak.period.toFixed(2),
      fastPeriodPx: +d.spectrum(fastT.error, fastT.travelled).peak.period.toFixed(2)
    };

    //    A wobble fixed in distance keeps its spatial period and changes its frequency.
    //    Period 20px, which at the faster speed is still 5 samples per cycle. An earlier
    //    version asked for a 3px wobble while advancing 3.75px per sample and got a
    //    confident wrong answer, which is why peaks now carry a wellSampled flag.
    const slowS = d.deviation(make({ amp: 0.7, perPixel: 1 / 20, speed: 0.25, n: 700 }));
    const fastS = d.deviation(make({ amp: 0.7, perPixel: 1 / 20, speed: 0.75, n: 700 }));
    R.spaceDefect = {
      slowPeriodPx: +d.spectrum(slowS.error, slowS.travelled).peak.period.toFixed(2),
      fastPeriodPx: +d.spectrum(fastS.error, fastS.travelled).peak.period.toFixed(2),
      slowHz: +d.spectrum(slowS.error, slowS.t.map((m) => m / 1000)).peak.frequency.toFixed(2),
      fastHz: +d.spectrum(fastS.error, fastS.t.map((m) => m / 1000)).peak.frequency.toFixed(2),
      slowWellSampled: d.spectrum(slowS.error, slowS.travelled).peak.wellSampled,
      fastWellSampled: d.spectrum(fastS.error, fastS.travelled).peak.wellSampled
    };

    //    And the guard itself: a wobble too fine for the sampling must be flagged, not
    //    reported as fact.
    const tooFine = d.deviation(make({ amp: 0.7, perPixel: 1 / 3, speed: 0.75, n: 700 }));
    R.tooFineFlagged = d.spectrum(tooFine.error, tooFine.travelled).peak.wellSampled === false;

    // 6. Sample timing, from a stroke with a known interval.
    const t = d.timing(make({ dt: 5, n: 400 }));
    R.rateHz = +t.rateHz.toFixed(1);
    R.meanInterval = +t.meanIntervalMs.toFixed(2);

    // 7. A pen held still: does the noise floor come back at the size it went in?
    const still = [];
    for (let i = 0; i < 800; i++) {
      // Box-Muller, so the input really is normal with the standard deviation claimed.
      const u = Math.max(1e-9, Math.random()), v = Math.random();
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      const g2 = Math.sqrt(-2 * Math.log(u)) * Math.sin(2 * Math.PI * v);
      still.push({ t: i * 5, x: 500 + g * 0.4, y: 300 + g2 * 0.6, pressure: 0.5, tilt: 0, twist: 0 });
    }
    const noise = d.stationaryNoise(still);
    R.sdXWanted = 0.4; R.sdXFound = +noise.sdX.toFixed(3);
    R.sdYWanted = 0.6; R.sdYFound = +noise.sdY.toFixed(3);

    // 8. Does report() route a stationary recording to the noise path and a moving one
    //    to the straightness path? Getting this backwards would call a held pen a very
    //    wobbly line.
    const stillReport = d.report({ label: 'still', source: 'synthetic', raw: still, drawn: [] });
    const moveReport = d.report({ label: 'moved', source: 'synthetic', raw: known, drawn: [] });
    R.stillTreatedAsNoise = stillReport.noise !== null && stillReport.bySpeed.length === 0;
    R.moveTreatedAsLine = moveReport.noise === null && moveReport.bySpeed.length > 0;

    // 9. Error grouped by speed. Built so the slow half is genuinely worse, which is the
    //    pattern that would justify easing the filter off as the pen speeds up.
    const mixed = [];
    let x = 100, tt = 0;
    for (let i = 0; i < 800; i++) {
      const slow = i < 400;
      const step = slow ? 0.1 : 1.2;
      x += step;
      tt += 5;
      const e = (Math.random() * 2 - 1) * (slow ? 1.0 : 0.15);
      mixed.push({ t: tt, x: x, y: 300 + e, pressure: 0.5, tilt: 0, twist: 0 });
    }
    const bands = d.errorBySpeed(d.deviation(mixed));
    R.bandCount = bands.length;
    R.slowestRms = +bands[0].rmsError.toFixed(3);
    R.fastestRms = +bands[bands.length - 1].rmsError.toFixed(3);

    return R;
  })()`)

  if (R.failed) {
    console.error('diag: ' + R.reason)
    app.exit(1)
    return
  }

  // Second half: the recorder has to be sitting in the real pen path, not just be a
  // class that works when called directly. Draws an actual stroke on the canvas with a
  // wobble of known size and checks it comes back out of the recorder unfiltered.
  const live = await win.webContents.executeJavaScript(String.raw`(async () => {
    const ed = window.editor;
    const cv = document.getElementById('view');
    const d = window.diag;
    if (!ed || !cv) return { failed: true, reason: 'not mounted' };
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    ed.recorder.clear();
    ed.recorder.label = 'test-stroke';

    const box = cv.getBoundingClientRect();
    const ev = (type, x, y, extra) => cv.dispatchEvent(new PointerEvent(type, Object.assign({
      pointerId: 4, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, pressure: 0.6
    }, extra || {})));
    const wait = () => new Promise((r) => setTimeout(r, 6));

    // A horizontal line with a 1.5px wobble, 20 cycles over 400px: a 20px period, which
    // is the scale real digitiser noise actually happens at. An earlier version used 8
    // cycles, a 50px lazy S that no stabiliser should touch and none did.
    const y0 = box.top + 300;
    const N = 240;
    const AMP = 1.5;
    const CYCLES = 20;
    ev('pointerdown', box.left + 200, y0);
    await wait();
    for (let i = 1; i <= N; i++) {
      const f = i / N;
      ev('pointermove', box.left + 200 + f * 400, y0 + AMP * Math.sin(2 * Math.PI * CYCLES * f));
      await wait();
    }
    ev('pointerup', box.left + 600, y0);
    await wait();
    await wait();

    const c = ed.recorder.last();
    if (!c) return { failed: true, reason: 'nothing recorded from a real stroke' };
    const rep = d.report(c);
    return {
      captured: ed.recorder.count,
      label: c.label,
      source: c.source,
      samples: c.raw.length,
      wantedSamples: N + 1,
      treatedAs: rep.treatedAs,
      rawRms: +rep.error.rms.toFixed(3),
      wantedRms: +(AMP / Math.SQRT2).toFixed(3),
      drawnRms: rep.drawnError ? +rep.drawnError.rms.toFixed(3) : null,
      hasDrawn: c.drawn.length > 2
    };
  })()`)

  if (live.failed) {
    console.error('diag: ' + live.reason)
    app.exit(1)
    return
  }
  console.log('')
  console.log('from a real stroke on the canvas:')
  console.log(JSON.stringify(live, null, 1))

  const fail = []
  const ok = (name, cond, detail) => {
    if (!cond) fail.push(name + ' — ' + detail)
  }
  const near = (a, b, tol) => Math.abs(a - b) <= tol

  for (const a of [0, 30, 45, 90, 135]) {
    ok(`finds a ${a} degree line`, R['angle' + a] < 0.5, 'off by ' + R['angle' + a] + ' deg')
  }
  ok('measures the size of a known wobble', near(R.rmsFound, R.rmsWanted, 0.02),
    'wanted rms ' + R.rmsWanted + ', got ' + R.rmsFound)
  ok('measures the peak of a known wobble', near(R.peakFound, 0.8, 0.02), 'got ' + R.peakFound)
  ok('finds the rate of a known wobble', near(R.hzFound, R.hzWanted, 0.6),
    'wanted 14 Hz, got ' + R.hzFound)
  ok('reports that wobble at the right size', near(R.hzAmplitude, 0.8, 0.12),
    'wanted amplitude 0.8, got ' + R.hzAmplitude)
  ok('calls a real periodic wobble prominent', R.hzProminence > 50, 'prominence ' + R.hzProminence)
  ok('does not call random noise periodic', R.noiseProminence < 15,
    'prominence ' + R.noiseProminence)

  const td = R.timeDefect
  ok('a wobble fixed in time keeps its frequency at both speeds', near(td.slowHz, td.fastHz, 1),
    td.slowHz + ' Hz slow vs ' + td.fastHz + ' Hz fast')
  ok('a wobble fixed in time changes its spatial period with speed',
    td.fastPeriodPx > td.slowPeriodPx * 2, td.slowPeriodPx + 'px slow vs ' + td.fastPeriodPx + 'px fast')
  const sd = R.spaceDefect
  ok('a wobble fixed in distance keeps its period at both speeds',
    near(sd.slowPeriodPx, sd.fastPeriodPx, 0.4),
    sd.slowPeriodPx + 'px slow vs ' + sd.fastPeriodPx + 'px fast')
  ok('a wobble fixed in distance changes its frequency with speed',
    sd.fastHz > sd.slowHz * 2, sd.slowHz + ' Hz slow vs ' + sd.fastHz + ' Hz fast')
  ok('a resolvable spatial wobble is marked trustworthy',
    sd.slowWellSampled === true && sd.fastWellSampled === true, 'flagged as unreliable')
  ok('a wobble too fine for the sampling is flagged, not reported',
    R.tooFineFlagged === true, 'reported an unresolvable period as fact')

  ok('reports the sample rate', near(R.rateHz, 200, 1), R.rateHz + ' Hz')
  ok('reports the sample interval', near(R.meanInterval, 5, 0.1), R.meanInterval + ' ms')
  ok('measures a known noise floor in x', near(R.sdXFound, R.sdXWanted, 0.06),
    'wanted ' + R.sdXWanted + ', got ' + R.sdXFound)
  ok('measures a known noise floor in y', near(R.sdYFound, R.sdYWanted, 0.08),
    'wanted ' + R.sdYWanted + ', got ' + R.sdYFound)
  ok('treats a held pen as a noise floor', R.stillTreatedAsNoise === true, 'measured it as a line')
  ok('treats a drawn line as a line', R.moveTreatedAsLine === true, 'measured it as noise')
  ok('groups error into speed bands', R.bandCount === 4, R.bandCount + ' bands')
  ok('sees more error at low speed when there is more', R.slowestRms > R.fastestRms * 2,
    'slow ' + R.slowestRms + ' vs fast ' + R.fastestRms)

  ok('a real stroke gets recorded', live.captured === 1, live.captured + ' captures')
  ok('the label goes on the capture', live.label === 'test-stroke', 'label was ' + live.label)
  ok('every sample is kept, unfiltered', live.samples === live.wantedSamples,
    'kept ' + live.samples + ' of ' + live.wantedSamples)
  ok('a drawn line is read as a line', live.treatedAs === 'drawn line', 'read as ' + live.treatedAs)
  ok('the recorded wobble is the one that was drawn',
    Math.abs(live.rawRms - live.wantedRms) < 0.12,
    'drew rms ' + live.wantedRms + ', measured ' + live.rawRms)
  ok('what the app drew is kept alongside the raw', live.hasDrawn === true, 'no drawn path')
  ok('the stabiliser measurably reduces the wobble',
    live.drawnRms !== null && live.drawnRms < live.rawRms,
    'raw ' + live.rawRms + ' vs drawn ' + live.drawnRms)

  if (errors.length) fail.push('console errors — ' + errors.slice(0, 3).join(' | '))

  console.log(JSON.stringify(R, null, 1))
  if (fail.length) {
    console.error('\ndiag FAILED:\n  ' + fail.join('\n  '))
    app.exit(1)
  } else {
    console.log('\ndiag: 33/33 — the analyser is correct, and it is wired into the real pen path')
    app.exit(0)
  }
})
