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
           * Repeatability, measured the only way that works.
           *
           * An earlier version compared horizontal passes by their along-track wiggle, which
           * was the wrong channel: the x error does show up there, but so does the hand
           * genuinely speeding up and slowing down, and that is far larger and does not
           * repeat. The ripple was being looked for through the noisiest signal available.
           *
           * Sideways error on a ruler pass is the clean channel. The straightedge holds the
           * hand steady in exactly that direction — ruler passes deviate sideways less than a
           * braced hand does on its own — so what is left is mostly the tablet.
           *
           * All passes are projected onto ONE reference line taken from the first, so a pass
           * drawn back the other way lands in the same frame rather than in its own mirrored
           * one. That matters, because direction is the sharpest discriminator there is: an
           * error fixed to the glass is the same function of position whichever way the pen
           * travels, while one produced by a filter reacting to movement follows the
           * direction of travel and will not line up when reversed.
           */
          const passes = findStroke(rec, 'repeat')
          if (passes.length >= 2) {
            const toScreen = function (c) {
              const scale = c.viewScale > 0 ? c.viewScale : 1
              return dedup(c.raw).map(function (p) {
                return { x: p.x * scale, y: p.y * scale, t: p.t, pressure: p.pressure,
                         tilt: p.tilt, twist: p.twist }
              })
            }
            const sets = passes.map(toScreen).filter(function (p) { return p.length >= 150 })
            if (sets.length >= 2) {
              const ref = d.fitLine(sets[0])
              const project = function (pts) {
                const along = []
                const err = []
                for (let i = 0; i < pts.length; i++) {
                  const ux = pts[i].x - ref.cx
                  const uy = pts[i].y - ref.cy
                  along.push(ux * ref.dx + uy * ref.dy)
                  err.push(ux * -ref.dy + uy * ref.dx)
                }
                // Sort by position, so a reversed pass reads forwards like the others.
                const order = along.map(function (v, i) { return i })
                  .sort(function (a, b) { return along[a] - along[b] })
                return {
                  along: order.map(function (i) { return along[i] }),
                  err: order.map(function (i) { return err[i] }),
                  reversed: along[along.length - 1] < along[0]
                }
              }
              const proj = sets.map(project)
              const lo = Math.max.apply(null, proj.map(function (p) { return p.along[0] }))
              const hi = Math.min.apply(null, proj.map(function (p) {
                return p.along[p.along.length - 1]
              }))
              const N = 1200
              const resample = function (p) {
                const out = []
                let j = 0
                for (let i = 0; i < N; i++) {
                  const at = lo + ((hi - lo) * i) / (N - 1)
                  while (j < p.along.length - 2 && p.along[j + 1] < at) j++
                  const a0 = p.along[j], a1 = p.along[j + 1]
                  const f = a1 > a0 ? (at - a0) / (a1 - a0) : 0
                  out.push(p.err[j] + (p.err[j + 1] - p.err[j]) * f)
                }
                // Band-pass in pixels of path, around the ripple, dropping the slow bow of
                // the ruler and the sample-to-sample noise.
                const avg = function (src, half) {
                  const o = new Array(src.length)
                  for (let i = 0; i < src.length; i++) {
                    const a = Math.max(0, i - half), b = Math.min(src.length - 1, i + half)
                    let m = 0
                    for (let k = a; k <= b; k++) m += src[k]
                    o[i] = m / (b - a + 1)
                  }
                  return o
                }
                const pxPerStep = (hi - lo) / (N - 1)
                const wide = avg(out, Math.round(110 / pxPerStep / 2))
                const noLow = out.map(function (v, i) { return v - wide[i] })
                return avg(noLow, Math.max(1, Math.round(14 / pxPerStep / 2)))
              }
              const bands = proj.map(resample)
              const corr = function (a, b) {
                let ma = 0, mb = 0
                for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i] }
                ma /= a.length; mb /= b.length
                let sab = 0, saa = 0, sbb = 0
                for (let i = 0; i < a.length; i++) {
                  const u = a[i] - ma, v = b[i] - mb
                  sab += u * v; saa += u * u; sbb += v * v
                }
                return sab / Math.sqrt(Math.max(1e-30, saa * sbb))
              }
              const pairs = []
              for (let i = 0; i < bands.length; i++) {
                for (let j = i + 1; j < bands.length; j++) {
                  pairs.push({
                    a: i, b: j,
                    sameDirection: proj[i].reversed === proj[j].reversed,
                    correlation: corr(bands[i], bands[j])
                  })
                }
              }
              result.repeat = {
                passes: bands.length,
                sharedPx: hi - lo,
                reversedCount: proj.filter(function (p) { return p.reversed }).length,
                rms: bands.map(function (b) { return d.spread(b).rms }),
                pairs: pairs
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
      const rp = r.repeat
      console.log('  repeated diagonal passes, compared sideways in a shared frame:')
      console.log(
        '    passes               ' + rp.passes + ' (' + rp.reversedCount + ' drawn the other way)'
      )
      console.log('    shared span          ' + num(rp.sharedPx, 0) + ' px')
      console.log('    ripple per pass      ' + rp.rms.map((v) => num(v, 3)).join(', ') + ' px')

      const same = rp.pairs.filter((p) => p.sameDirection)
      const opposite = rp.pairs.filter((p) => !p.sameDirection)
      const mean = (a) => (a.length ? a.reduce((s, p) => s + p.correlation, 0) / a.length : null)
      const ms = mean(same)
      const mo = mean(opposite)
      if (ms !== null) console.log('    same direction       ' + num(ms, 3) + ' correlation')
      if (mo !== null) console.log('    opposite direction   ' + num(mo, 3) + ' correlation')

      console.log('    reading:')
      if (ms === null) {
        console.log('      not enough passes in one direction to say anything')
      } else if (ms > 0.5) {
        console.log('      the ripple lands in the same places every pass.')
        console.log('      It is fixed to the glass, so it can be SUBTRACTED — a correction')
        console.log('      map, no smoothing, no lag.')
        if (mo !== null && mo > 0.5) {
          console.log('      And it survives reversing direction, which rules out a driver')
          console.log('      filter reacting to movement. This is the geometry of the sensor.')
        } else if (mo !== null) {
          console.log('      But it does NOT survive reversing direction, so part of it')
          console.log('      follows the pen rather than the glass — a driver filter on top')
          console.log('      of a fixed error.')
        }
      } else if (ms > 0.2) {
        console.log('      partly repeatable: some of the ripple is fixed to position and')
        console.log('      some is not. A correction map would take out the fixed part; the')
        console.log('      rest needs a narrow filter at the ripple frequency.')
      } else {
        console.log('      the ripple does not land in the same places. It is made by the')
        console.log('      movement, not by the glass, so a correction map cannot touch it.')
        console.log('      A notch filter at the ripple frequency is the remaining option,')
        console.log('      and it costs far less lag than a general stabiliser.')
      }
    }
  }
  console.log('')
  app.exit(0)
})
