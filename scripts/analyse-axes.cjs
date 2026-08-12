/**
 * Is the diagonal wobble a periodic error in each axis?
 *
 *   npx electron scripts/analyse-axes.cjs <file.json> [more.json ...]
 *
 * The hypothesis, which comes from the fact that horizontal and vertical passes are clean
 * while diagonals are not:
 *
 * Suppose the digitiser reports x with a small periodic error that depends on x, and y with
 * one that depends on y — the sort of thing a sensor grid with interpolation between sense
 * lines produces. Then on a horizontal pass only x is sweeping, so its error pushes the pen
 * ALONG the line where it cannot be seen, while y sits still and contributes a constant
 * offset. Same for a vertical pass with the axes swapped. But on a diagonal both axes sweep
 * at once and both errors project sideways, so the ripple appears.
 *
 * That predicts something specific and falsifiable. The ripple period measured along a
 * diagonal should be about 1.41 times the period of the along-track ripple measured on a
 * horizontal or vertical pass, because a diagonal covers 1.41 px of path for every 1 px of x.
 *
 * If it holds, this is not noise and filtering is the wrong tool: an error that is a
 * repeatable function of position can be subtracted outright, with no smoothing and no lag.
 * The repeatability check at the end is what decides that — the same ripple at the same
 * places on two passes drawn at different speeds cannot be a hand.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const files = process.argv.filter((a) => a.endsWith('.json'))

if (files.length === 0) {
  process.stderr.write('usage: electron scripts/analyse-axes.cjs <file.json> [...]\n')
  process.exit(1)
}

const num = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(n))

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
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 2000))

  const payloads = files.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }))

  const out = await win.webContents.executeJavaScript(
    '(' +
      function (inputs) {
        const d = window.diag
        if (!d || !d.report) return { failed: 'diag not exposed' }

        /*
         * Half the samples repeat the previous position exactly, and a repeated position is
         * not evidence of anything — left in, they flatten the very ripple being looked for.
         */
        const dedup = function (pts) {
          const out = []
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i]
            const q = out[out.length - 1]
            if (!q || p.x !== q.x || p.y !== q.y) out.push(p)
          }
          return out
        }

        /*
         * The wiggle in a signal, with the smooth part taken out.
         *
         * A centred moving average is removed rather than a straight line, because the hand
         * speeds up and slows down over the length of a stroke and that is a real movement,
         * not an error. The window is wide enough to leave a ripple of a few tens of pixels
         * untouched and narrow enough to follow the hand.
         */
        const detrend = function (v, half) {
          const out = new Array(v.length)
          for (let i = 0; i < v.length; i++) {
            const a = Math.max(0, i - half)
            const b = Math.min(v.length - 1, i + half)
            let mean = 0
            for (let k = a; k <= b; k++) mean += v[k]
            out[i] = v[i] - mean / (b - a + 1)
          }
          return out
        }

        const findStroke = function (recorded, label) {
          return recorded.filter(function (c) {
            return c.label === label
          })
        }

        return inputs.map(function (input) {
          const parsed = JSON.parse(input.text)
          const rec = parsed.recorded
          const result = { file: input.name, axes: [], diagonals: [], repeat: null }

          // --- the per-axis ripple, seen as along-track wiggle -------------------
          // On a horizontal pass, distance along the line IS x, so an x error shows up as
          // the pen appearing to hurry and dawdle. That is the thing to measure.
          const axisTests = [
            { label: 'h-slow', axis: 'x' },
            { label: 'h-fast', axis: 'x' },
            { label: 'v-slow', axis: 'y' },
            { label: 'v-fast', axis: 'y' }
          ]
          for (let t = 0; t < axisTests.length; t++) {
            const test = axisTests[t]
            const found = findStroke(rec, test.label)
            for (let s = 0; s < found.length; s++) {
              const c = found[s]
              const scale = c.viewScale > 0 ? c.viewScale : 1
              const pts = dedup(c.raw).map(function (p) {
                return { x: p.x * scale, y: p.y * scale, t: p.t, pressure: p.pressure,
                         tilt: p.tilt, twist: p.twist }
              })
              if (pts.length < 200) continue
              const along = pts.map(function (p) {
                return test.axis === 'x' ? p.x : p.y
              })
              const wiggle = detrend(along, 20)
              const sp = d.spectrum(wiggle, along, 1024)
              result.axes.push({
                label: test.label,
                axis: test.axis,
                samples: pts.length,
                span: Math.abs(along[along.length - 1] - along[0]),
                rms: d.spread(wiggle).rms,
                peak: sp.peak
              })
            }
          }

          // --- the diagonal ripple, seen sideways -------------------------------
          const diagTests = ['d-slow', 'd-fast']
          for (let t = 0; t < diagTests.length; t++) {
            const found = findStroke(rec, diagTests[t])
            for (let s = 0; s < found.length; s++) {
              const c = found[s]
              const scale = c.viewScale > 0 ? c.viewScale : 1
              const pts = dedup(c.raw).map(function (p) {
                return { x: p.x * scale, y: p.y * scale, t: p.t, pressure: p.pressure,
                         tilt: p.tilt, twist: p.twist }
              })
              if (pts.length < 200) continue
              const dev = d.deviation(pts)
              // Take out the slow bow so a gentle curve in the ruler pass does not dominate.
              const wiggle = detrend(dev.error, 20)
              const sp = d.spectrum(wiggle, dev.travelled, 1024)
              const angle = (Math.atan2(dev.line.dy, dev.line.dx) * 180) / Math.PI
              result.diagonals.push({
                label: diagTests[t],
                samples: pts.length,
                angleDeg: angle,
                rms: d.spread(wiggle).rms,
                peak: sp.peak
              })
            }
          }

          /*
           * Repeatability: the question that decides whether this can be corrected.
           *
           * Two horizontal passes at different speeds. If the wiggle is a property of WHERE
           * the pen is, both passes carry the same wiggle at the same x, and lining them up
           * by x gives a positive correlation. If it is a hand or plain noise, there is
           * nothing to line up and the correlation sits near zero.
           */
          /*
           * Compared within one session only, never across two.
           *
           * The samples are in document space and the report scales them by the zoom, which
           * does not account for where the canvas was panned to. Two sessions with different
           * pan would put the same tablet position at different numbers, and the phase of the
           * ripple would appear to move when nothing had. Captures need the full camera
           * transform stored before a cross-session comparison means anything.
           */
          const hs = findStroke(rec, 'h-slow').concat(findStroke(rec, 'h-fast'))
          if (hs.length >= 2) {
            const prep = function (c) {
              const scale = c.viewScale > 0 ? c.viewScale : 1
              const pts = dedup(c.raw)
              const xs = pts.map(function (p) { return p.x * scale })
              return { xs: xs, w: detrend(xs, 20) }
            }
            /*
             * Keep only the band the ripple lives in, measured in pixels of x.
             *
             * Removing a wide average kills the arm sweeping and accelerating, which on a fast
             * pass is forty times larger than the ripple and would otherwise be the only thing
             * the correlation sees. Then a narrow average kills the sample-to-sample noise.
             * What survives is a wobble of a few tens of pixels — the thing being tested.
             */
            const bandpass = function (v, lowPx, highPx) {
              const avg = function (src, half) {
                const out = new Array(src.length)
                for (let i = 0; i < src.length; i++) {
                  const a = Math.max(0, i - half)
                  const b = Math.min(src.length - 1, i + half)
                  let m = 0
                  for (let k = a; k <= b; k++) m += src[k]
                  out[i] = m / (b - a + 1)
                }
                return out
              }
              const wide = avg(v, Math.round(lowPx / 2))
              const noLow = v.map(function (x, i) { return x - wide[i] })
              return avg(noLow, Math.round(highPx / 2))
            }
            const A = prep(hs[0])
            const B = prep(hs[1])
            // Resample both onto the same grid of x, over the range they share.
            const lo = Math.max(Math.min.apply(null, A.xs), Math.min.apply(null, B.xs))
            const hi = Math.min(Math.max.apply(null, A.xs), Math.max.apply(null, B.xs))
            const N = Math.max(600, Math.round(2400))
            const sample = function (S) {
              const out = []
              const asc = S.xs[S.xs.length - 1] > S.xs[0]
              const xs = asc ? S.xs : S.xs.slice().reverse()
              const w = asc ? S.w : S.w.slice().reverse()
              let j = 0
              for (let i = 0; i < N; i++) {
                const at = lo + ((hi - lo) * i) / (N - 1)
                while (j < xs.length - 2 && xs[j + 1] < at) j++
                const x0 = xs[j], x1 = xs[j + 1]
                const f = x1 > x0 ? (at - x0) / (x1 - x0) : 0
                out.push(w[j] + (w[j + 1] - w[j]) * f)
              }
              return out
            }
            if (hi - lo > 200) {
              // One pixel of x per grid step, so the band-pass windows below are in pixels.
              const a = bandpass(sample(A), 90, 12)
              const b = bandpass(sample(B), 90, 12)
              let ma = 0, mb = 0
              for (let i = 0; i < N; i++) { ma += a[i]; mb += b[i] }
              ma /= N; mb /= N
              let sab = 0, saa = 0, sbb = 0
              for (let i = 0; i < N; i++) {
                const u = a[i] - ma, v = b[i] - mb
                sab += u * v; saa += u * u; sbb += v * v
              }
              result.repeat = {
                overlapPx: hi - lo,
                correlation: sab / Math.sqrt(Math.max(1e-30, saa * sbb)),
                rmsA: Math.sqrt(saa / N),
                rmsB: Math.sqrt(sbb / N)
              }
            }
          }
          return result
        })
      }.toString() +
      ')(' +
      JSON.stringify(payloads) +
      ')'
  )

  if (out.failed) {
    process.stderr.write(out.failed + '\n')
    app.exit(1)
    return
  }

  const show = (p) => {
    if (!p) return 'none found'
    if (p.prominence < 15) return 'no pattern (prominence ' + num(p.prominence, 1) + ')'
    if (!p.wellSampled) return 'too fine for this sample rate'
    return (
      'every ' + num(p.period) + ' px, ' + num(p.amplitude, 3) + ' px, prominence ' +
      num(p.prominence, 0)
    )
  }

  for (const r of out) {
    console.log('')
    console.log('  ' + r.file)
    console.log('  along-track ripple, which reveals each axis on its own:')
    for (const a of r.axes) {
      console.log(
        '    ' + a.label.padEnd(9) + a.axis + '  span ' + num(a.span, 0) + 'px  wiggle rms ' +
          num(a.rms, 3) + 'px   ' + show(a.peak)
      )
    }
    console.log('  sideways ripple on the diagonals:')
    for (const g of r.diagonals) {
      console.log(
        '    ' + g.label.padEnd(9) + num(g.angleDeg, 0) + ' deg  wiggle rms ' +
          num(g.rms, 3) + 'px   ' + show(g.peak)
      )
    }

    // The prediction: a diagonal covers 1.41 px of path per 1 px of x.
    /*
     * Slow passes only. A fast pass is dominated by the arm accelerating into and out of the
     * stroke, which the spectrum reports as a "period" of several hundred pixels — the length
     * of the stroke, not a property of the tablet. Averaging that in buried the result.
     *
     * And the angle is each diagonal's own measured angle rather than 45 degrees, because the
     * passes came in at 36 and 39 and the prediction depends on it: a ripple of period P in x
     * appears with period P divided by the cosine of the angle along a tilted path.
     */
    const hx = r.axes.find((a) => a.label === 'h-slow' && a.peak && a.peak.wellSampled)
    const dg = r.diagonals.find((g) => g.label === 'd-slow' && g.peak && g.peak.wellSampled)
    if (hx && dg) {
      const theta = (Math.abs(dg.angleDeg) * Math.PI) / 180
      const predicted = hx.peak.period / Math.cos(theta)
      console.log('  the prediction, from the x ripple alone:')
      console.log('    ripple in x          ' + num(hx.peak.period) + ' px')
      console.log('    diagonal angle       ' + num(dg.angleDeg, 0) + ' deg')
      console.log('    predicted sideways   ' + num(predicted) + ' px')
      console.log('    measured sideways    ' + num(dg.peak.period) + ' px')
      console.log(
        '    off by               ' +
          num(Math.abs(predicted - dg.peak.period) / dg.peak.period * 100, 1) + '%'
      )
    }

    if (r.repeat) {
      console.log('  repeatability of two horizontal passes, lined up by x:')
      console.log('    shared span          ' + num(r.repeat.overlapPx, 0) + ' px')
      console.log('    correlation          ' + num(r.repeat.correlation, 3))
      console.log(
        '    wiggle sizes         ' + num(r.repeat.rmsA, 3) + ' and ' + num(r.repeat.rmsB, 3) + ' px'
      )
      const c = r.repeat.correlation
      console.log(
        '    reading              ' +
          (c > 0.5
            ? 'strongly repeatable — a property of position, correctable outright'
            : c > 0.2
              ? 'partly repeatable — some of it is fixed to position'
              : 'not repeatable — this part is noise or hand, only filtering can touch it')
      )
    }
  }
  console.log('')
  app.exit(0)
})
