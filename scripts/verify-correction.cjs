/**
 * Does subtracting a measured distortion actually cancel it?
 *
 * Tested against a tablet that does not exist, whose distortion is therefore known exactly.
 * A synthetic digitiser is given a specific error in x — part of it a ripple with a period, part
 * of it a bump that has no period at all, since the real data showed the repeatable part is not
 * purely periodic. Strokes are then drawn across it with a hand that wobbles differently every
 * pass, which is the situation the calibration has to cope with: the thing being measured is
 * several times smaller than the thing on top of it, and only averaging separates them.
 *
 * The checks that matter, in order of how easy they are to fool:
 *
 *   1. The calibration recovers the shape of the error it was never told.
 *   2. Correcting a diagonal removes its sideways ripple, on passes not used to calibrate.
 *   3. Correcting a CLEAN input does not damage it. A correction that flatters a wobbly stroke
 *      by quietly smoothing everything would fail here, and this is the check that separates
 *      subtracting a known error from filtering.
 *   4. Nothing is delayed. The corrected position of a sample depends on that sample alone.
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
    if (!d || !d.buildAxisTable) return { failed: true, reason: 'correction not exposed' };

    // The distortion this fictional digitiser has in x. A ripple plus a bump, because the real
    // one is repeatable without being a single sine, which is what limited the first attempt.
    const RIPPLE_PERIOD = 40;
    const RIPPLE_AMP = 0.30;
    const trueXError = (x) =>
      RIPPLE_AMP * Math.sin((2 * Math.PI * x) / RIPPLE_PERIOD) +
      0.12 * Math.sin((2 * Math.PI * x) / 137 + 1.1);

    /*
     * A hand that also varies its speed ALONG the stroke, not only across it.
     *
     * The first version of this test moved the hand across the stroke only, which left the
     * along-track channel — the one the calibration reads — perfectly clean. It passed easily
     * and was worthless: the real calibration then failed on twelve real passes, because a real
     * arm hurries and dawdles by around a pixel and that lands straight in the measurement.
     * Measured afterwards: with no along-track variation the table is recovered to within 6% on
     * twelve passes, with 1 px of it twelve passes gives a table as wrong as it is right, and
     * with 3 px even two hundred passes is worse than no correction at all.
     */
    const hand = (seed) => {
      let s = seed;
      const rnd = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const a = [];
      for (let k = 0; k < 6; k++) a.push({ amp: 0.5 + rnd(), ph: rnd() * 6.283, per: 120 + rnd() * 500 });
      return (t) => a.reduce((sum, w) => sum + w.amp * Math.sin((2 * Math.PI * t) / w.per + w.ph), 0);
    };

    // One pass across the surface. The reported x carries the distortion; the hand moves the
    // pen for real, so it belongs in the position rather than in the error.
    const pass = (opts) => {
      const wob = hand(opts.seed);
      const pts = [];
      const n = opts.n || 900;
      const along = opts.handAlong || 0;
      for (let i = 0; i < n; i++) {
        const s = (i / (n - 1)) * opts.length + (opts.handOn ? wob(i * 3.1) * along : 0);
        const trueX = opts.x0 + s * Math.cos(opts.angle) + (opts.handOn ? wob(s) * opts.handAcross * -Math.sin(opts.angle) : 0);
        const trueY = opts.y0 + s * Math.sin(opts.angle) + (opts.handOn ? wob(s) * opts.handAcross * Math.cos(opts.angle) : 0);
        pts.push({
          t: i * 2.5,
          x: trueX + (opts.clean ? 0 : trueXError(trueX)),
          y: trueY,
          pressure: 0.5, tilt: 0, twist: 0
        });
      }
      return pts;
    };

    const R = {};

    // --- 1. calibrate from many horizontal passes -------------------------------
    const calPasses = [];
    for (let k = 0; k < 40; k++) {
      calPasses.push(d.axisWiggle(
        pass({ x0: 200, y0: 300 + k * 7, angle: 0, length: 1600, seed: 7 + k * 13,
               handOn: true, handAcross: 1.0 }),
        'x'
      ));
    }
    const tableX = d.buildAxisTable(calPasses, 4);
    R.builtTable = !!tableX;
    R.bins = tableX ? tableX.offsets.length : 0;

    // Does the recovered table look like the error it was never shown?
    let sumA = 0, sumB = 0, sumAB = 0, sumAA = 0, sumBB = 0, n = 0;
    for (let i = 0; i < tableX.offsets.length; i++) {
      if (tableX.weight[i] < 8) continue;
      const x = tableX.origin + i * tableX.step;
      const want = trueXError(x);
      const got = tableX.offsets[i];
      sumA += want; sumB += got; n++;
      sumAB += want * got; sumAA += want * want; sumBB += got * got;
    }
    const ma = sumA / n, mb = sumB / n;
    const cov = sumAB / n - ma * mb;
    R.shapeCorrelation = cov / Math.sqrt(Math.max(1e-30, (sumAA / n - ma * ma) * (sumBB / n - mb * mb)));
    R.recoveredAmplitude = Math.sqrt(sumBB / n - mb * mb);
    R.trueAmplitude = Math.sqrt(sumAA / n - ma * ma);

    const correction = { x: tableX, y: null };

    // --- 2. a diagonal the calibration never saw -------------------------------
    const diag45 = pass({ x0: 250, y0: 200, angle: Math.PI / 4, length: 1400, seed: 999,
                          handOn: true, handAcross: 1.0 });
    const scored = d.scoreCorrection(diag45, correction);
    R.diagBefore = scored.before;
    R.diagAfter = scored.after;
    R.diagRemoved = scored.removed;
    /*
     * How much of the DISTORTION went, rather than what share of the total.
     *
     * The share of the total is dominated by whatever else is on the stroke: with a synthetic
     * hand several times larger than the distortion, cancelling the distortion perfectly still
     * only moves the total by a tenth. Since the distortion here is known exactly, the amount
     * removed can be compared against it directly, and that is the claim being tested.
     */
    const removedRms = Math.sqrt(Math.max(0, scored.before * scored.before - scored.after * scored.after));
    R.distortionSideways = RIPPLE_AMP / Math.SQRT2;
    R.shareOfDistortion = removedRms / (0.228 / Math.SQRT2);

    // A diagonal with no hand at all, which isolates how much of the distortion is cancelled.
    const diagPure = pass({ x0: 250, y0: 200, angle: Math.PI / 4, length: 1400, seed: 1,
                            handOn: false, handAcross: 0 });
    const scoredPure = d.scoreCorrection(diagPure, correction);
    R.pureBefore = scoredPure.before;
    R.pureAfter = scoredPure.after;
    R.pureRemoved = scoredPure.removed;

    // --- 3. clean input must not be damaged -----------------------------------
    // Same stroke through a perfect digitiser. A correction is entitled to remove the error it
    // measured and nothing else; anything that improves this number is smoothing, not correcting.
    const cleanDiag = pass({ x0: 250, y0: 200, angle: Math.PI / 4, length: 1400, seed: 4242,
                             handOn: true, handAcross: 1.0, clean: true });
    const scoredClean = d.scoreCorrection(cleanDiag, correction);
    R.cleanBefore = scoredClean.before;
    R.cleanAfter = scoredClean.after;
    R.cleanChange = scoredClean.before > 0 ? scoredClean.after / scoredClean.before - 1 : 0;

    // --- 4. no delay ----------------------------------------------------------
    // The same coordinate must correct to the same value regardless of what came before it, and
    // of whether anything came before it at all.
    const probe = 640.37;
    const a1 = d.correct(correction, probe, 100).x;
    const a2 = d.correct(correction, probe, 900).x;
    d.correct(correction, probe + 250, 100);
    const a3 = d.correct(correction, probe, 100).x;
    R.sameEveryTime = a1 === a2 && a1 === a3;
    R.movesTheSample = Math.abs(a1 - probe) > 0.01;

    // An uncalibrated area is left completely alone rather than guessed at.
    const far = d.correct(correction, tableX.origin + tableX.step * tableX.offsets.length + 5000, 0);
    R.untouchedFarAway = Math.abs(far.x - (tableX.origin + tableX.step * tableX.offsets.length + 5000)) < 1e-9;

    /*
     * --- 5. the limit, recorded as a test ------------------------------------
     *
     * With a realistic amount of along-track hand variation, calibrating from the along-track
     * channel does NOT work at this number of passes, and this asserts that it does not — so
     * that a future attempt to use it has to confront the measurement rather than rediscover it
     * on a live tablet. The clean-channel result above is the mechanism working; this is the
     * channel being unusable, which are different claims.
     */
    const noisyCal = [];
    for (let k = 0; k < 12; k++) {
      noisyCal.push(d.axisWiggle(
        pass({ x0: 200, y0: 300 + k * 7, angle: 0, length: 1600, seed: 7 + k * 13,
               handOn: true, handAcross: 1.0, handAlong: 1.0 }),
        'x'
      ));
    }
    const noisyTable = d.buildAxisTable(noisyCal, 4);
    let msq = 0, tsq = 0, mn = 0;
    for (let i = 0; i < noisyTable.offsets.length; i++) {
      if (noisyTable.weight[i] < 8) continue;
      const x = noisyTable.origin + i * noisyTable.step;
      const want = trueXError(x);
      msq += (noisyTable.offsets[i] - want) * (noisyTable.offsets[i] - want);
      tsq += want * want;
      mn++;
    }
    R.noisyChannelMisfit = Math.sqrt(msq / mn) / Math.sqrt(tsq / mn);

    // --- 6. averaging is what does the work -----------------------------------
    // Two passes should be nowhere near as good as forty. If they are, the hand is not being
    // cancelled and something is wrong with the premise.
    const few = d.buildAxisTable(calPasses.slice(0, 2), 4);
    const scoredFew = d.scoreCorrection(diag45, { x: few, y: null });
    R.fewPassesRemoved = scoredFew.removed;

    return R;
  })()`)

  if (R.failed) {
    console.error('correction: ' + R.reason)
    app.exit(1)
    return
  }

  const fail = []
  const ok = (name, cond, detail) => {
    if (!cond) fail.push(name + ' — ' + detail)
  }
  const pct = (v) => (v * 100).toFixed(1) + '%'

  ok('a table gets built', R.builtTable === true, 'no table')
  ok('the table covers the swept range', R.bins > 300, R.bins + ' bins')
  ok(
    'the recovered shape matches the real distortion',
    R.shapeCorrelation > 0.9,
    'correlation ' + R.shapeCorrelation.toFixed(3)
  )
  ok(
    'the recovered size is right',
    Math.abs(R.recoveredAmplitude - R.trueAmplitude) < 0.06,
    'recovered ' + R.recoveredAmplitude.toFixed(3) + ' vs true ' + R.trueAmplitude.toFixed(3)
  )
  ok(
    'a diagonal with a hand on it improves',
    R.diagRemoved > 0.05,
    pct(R.diagRemoved) + ' of the total (' + R.diagBefore.toFixed(3) + ' to ' + R.diagAfter.toFixed(3) + ')'
  )
  ok(
    'nearly all of the distortion is cancelled, hand or no hand',
    R.shareOfDistortion > 0.8,
    pct(R.shareOfDistortion) + ' of the known distortion removed'
  )
  ok(
    'a diagonal with no hand improves a lot',
    R.pureRemoved > 0.7,
    pct(R.pureRemoved) + ' removed (' + R.pureBefore.toFixed(3) + ' to ' + R.pureAfter.toFixed(3) + ')'
  )
  ok(
    'clean input is left alone',
    Math.abs(R.cleanChange) < 0.15,
    'changed by ' + pct(R.cleanChange)
  )
  ok('the same coordinate always corrects the same', R.sameEveryTime === true, 'it varied')
  ok('the correction actually moves samples', R.movesTheSample === true, 'no change applied')
  ok('uncalibrated areas are untouched', R.untouchedFarAway === true, 'it guessed')
  ok(
    'the along-track channel is known to be unusable at this many passes',
    R.noisyChannelMisfit > 0.7,
    'misfit ratio ' + R.noisyChannelMisfit.toFixed(2) + ' — if this has genuinely improved, ' +
      'the real calibration is worth retrying'
  )
  ok(
    'averaging many passes beats averaging two',
    R.diagRemoved > R.fewPassesRemoved + 0.08,
    'forty gave ' + pct(R.diagRemoved) + ', two gave ' + pct(R.fewPassesRemoved)
  )

  if (errors.length) fail.push('console errors — ' + errors.slice(0, 3).join(' | '))

  console.log(
    JSON.stringify(
      {
        shapeCorrelation: +R.shapeCorrelation.toFixed(3),
        recoveredAmplitude: +R.recoveredAmplitude.toFixed(3),
        trueAmplitude: +R.trueAmplitude.toFixed(3),
        diagonalWithHand: pct(R.diagRemoved),
        diagonalNoHand: pct(R.pureRemoved),
        cleanInputChange: pct(R.cleanChange),
        twoPassesOnly: pct(R.fewPassesRemoved),
        shareOfKnownDistortion: pct(R.shareOfDistortion),
        alongTrackChannelMisfit: R.noisyChannelMisfit.toFixed(2)
      },
      null,
      1
    )
  )

  if (fail.length) {
    console.error('correction FAILED:')
    console.error('  ' + fail.join('\n  '))
    app.exit(1)
  } else {
    console.log('')
    console.log('correction: 13/13 — a measured distortion can be subtracted, with no delay')
    app.exit(0)
  }
})
