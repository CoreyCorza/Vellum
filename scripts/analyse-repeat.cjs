/**
 * Does the ripple land in the same places every pass?
 *
 *   npx electron scripts/analyse-repeat.cjs <file.json>
 *
 * This is the question the whole investigation turns on. A ripple that sits at fixed places
 * on the glass can be subtracted — a correction map, no smoothing, no lag. One made by the
 * movement cannot, and needs a filter instead.
 *
 * Handles the recording as it was actually taken: one continuous stroke run up and down the
 * ruler several times without lifting the pen, which is better than separate passes because
 * nothing can shift in between. The passes are found by looking for where the pen turned
 * around, and every one is measured in the same frame.
 *
 * Direction is the sharp part. An error fixed to the glass is the same function of position
 * whichever way the pen travels. An error produced by something reacting to movement follows
 * the pen, so reversing direction breaks the alignment. Same-direction and opposite-direction
 * pairs are therefore reported separately, and the difference between them is the answer.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const file = process.argv.find((a) => a.endsWith('.json'))
if (!file || !fs.existsSync(file)) {
  process.stderr.write('usage: electron scripts/analyse-repeat.cjs <file.json>\n')
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

  const out = await win.webContents.executeJavaScript(
    '(' +
      function (text) {
        const d = window.diag
        if (!d || !d.report) return { failed: 'diag not exposed' }
        const parsed = JSON.parse(text)

        const dedup = function (pts) {
          const out = []
          for (let i = 0; i < pts.length; i++) {
            const q = out[out.length - 1]
            if (!q || pts[i].x !== q.x || pts[i].y !== q.y) out.push(pts[i])
          }
          return out
        }
        const avg = function (src, half) {
          const o = new Array(src.length)
          for (let i = 0; i < src.length; i++) {
            const a = Math.max(0, i - half)
            const b = Math.min(src.length - 1, i + half)
            let m = 0
            for (let k = a; k <= b; k++) m += src[k]
            o[i] = m / (b - a + 1)
          }
          return o
        }

        // Every 'repeat' recording, and any continuous stroke long enough to contain several
        // passes, since the test can be taken either way.
        const candidates = parsed.recorded.filter(function (c) {
          return c.label === 'repeat' || c.raw.length > 4000
        })
        if (candidates.length === 0) return { failed: 'no repeat recording in this file' }

        const results = candidates.map(function (c) {
          const scale = c.viewScale > 0 ? c.viewScale : 1
          const pts = dedup(c.raw).map(function (p) {
            return { x: p.x * scale, y: p.y * scale, t: p.t, pressure: p.pressure,
                     tilt: p.tilt, twist: p.twist }
          })
          const ref = d.fitLine(pts)
          const along = []
          const err = []
          for (let i = 0; i < pts.length; i++) {
            const ux = pts[i].x - ref.cx
            const uy = pts[i].y - ref.cy
            along.push(ux * ref.dx + uy * ref.dy)
            err.push(ux * -ref.dy + uy * ref.dx)
          }

          /*
           * Where did the pen turn around?
           *
           * Found on a heavily smoothed copy of the along-track position, so the ripple and
           * the sample noise cannot invent a turn. A reversal only counts once the pen has
           * committed to the new direction by a good fraction of the ruler, which stops a
           * pause at the end of a pass from being read as several turns.
           */
          const smooth = avg(along, 40)
          const fullSpan = Math.max.apply(null, smooth) - Math.min.apply(null, smooth)
          const commit = fullSpan * 0.15
          const cuts = [0]
          let dir = 0
          let anchor = smooth[0]
          for (let i = 1; i < smooth.length; i++) {
            const move = smooth[i] - anchor
            if (dir === 0) {
              if (Math.abs(move) > commit) {
                dir = move > 0 ? 1 : -1
                anchor = smooth[i]
              }
            } else if (move * dir < -commit) {
              cuts.push(i)
              dir = -dir
              anchor = smooth[i]
            } else if (move * dir > 0) {
              anchor = smooth[i]
            }
          }
          cuts.push(smooth.length)

          const passes = []
          for (let k = 0; k + 1 < cuts.length; k++) {
            const a = cuts[k]
            const b = cuts[k + 1]
            if (b - a < 200) continue
            const seg = { along: along.slice(a, b), err: err.slice(a, b) }
            const span = Math.max.apply(null, seg.along) - Math.min.apply(null, seg.along)
            if (span < fullSpan * 0.6) continue
            const forward = seg.along[seg.along.length - 1] > seg.along[0]
            // Sorted by position, so a pass drawn the other way reads forwards like the rest.
            const order = seg.along.map(function (v, i) { return i })
              .sort(function (i, j) { return seg.along[i] - seg.along[j] })
            passes.push({
              samples: b - a,
              span: span,
              forward: forward,
              along: order.map(function (i) { return seg.along[i] }),
              err: order.map(function (i) { return seg.err[i] })
            })
          }

          if (passes.length < 2) {
            return { samples: pts.length, passes: passes.length, tooFew: true,
                     angleDeg: (Math.atan2(ref.dy, ref.dx) * 180) / Math.PI }
          }

          const lo = Math.max.apply(null, passes.map(function (p) { return p.along[0] }))
          const hi = Math.min.apply(null, passes.map(function (p) {
            return p.along[p.along.length - 1]
          }))
          const N = 1500
          const step = (hi - lo) / (N - 1)

          /*
           * Split into bands, because "fixed to position" has two possible authors.
           *
           * A physical straightedge is not straight either. Its own bow and nicks are fixed
           * to position exactly like a sensor error, they repeat perfectly on every pass, and
           * they survive reversing direction — so a single correlation cannot tell the two
           * apart. What distinguishes them is scale: a ruler's imperfection is a long, gentle
           * undulation over hundreds of pixels, while the sensor ripple has a specific short
           * period that was measured independently at 39 px in x, about 49 px along a
           * diagonal at this angle.
           *
           * So the bands are reported separately. Agreement in the long band says the ruler
           * repeats, which is unsurprising. Agreement in the short band is the finding.
           */
          const BANDS = [
            { name: 'ripple band (30-70 px)', low: 70, high: 30 },
            { name: 'long undulation (>120 px)', low: 100000, high: 120 }
          ]

          const prepared = passes.map(function (p) {
            const raw = []
            let j = 0
            for (let i = 0; i < N; i++) {
              const at = lo + step * i
              while (j < p.along.length - 2 && p.along[j + 1] < at) j++
              const a0 = p.along[j], a1 = p.along[j + 1]
              const f = a1 > a0 ? (at - a0) / (a1 - a0) : 0
              raw.push(p.err[j] + (p.err[j + 1] - p.err[j]) * f)
            }
            // Band-pass around the ripple, in pixels of path: drop the ruler's slow bow and
            // the sample-to-sample noise, keep a wobble of a few tens of pixels.
            const positions = []
            for (let i = 0; i < N; i++) positions.push(lo + step * i)
            const inBand = function (lowPx, highPx) {
              const src = lowPx > 10000
                ? raw
                : (function () {
                    const wide = avg(raw, Math.max(1, Math.round(lowPx / step / 2)))
                    return raw.map(function (v, i) { return v - wide[i] })
                  })()
              return avg(src, Math.max(1, Math.round(highPx / step / 2)))
            }
            const bands = BANDS.map(function (b) { return inBand(b.low, b.high) })
            const wide = avg(raw, Math.max(1, Math.round(120 / step / 2)))
            const noLow = raw.map(function (v, i) { return v - wide[i] })
            const band = avg(noLow, Math.max(1, Math.round(14 / step / 2)))
            return {
              forward: p.forward,
              band: band,
              bands: bands,
              rms: d.spread(band).rms,
              bandRms: bands.map(function (b) { return d.spread(b).rms }),
              peak: d.spectrum(band, positions, 1024).peak,
              bandPeaks: bands.map(function (b) { return d.spectrum(b, positions, 1024).peak })
            }
          })

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
          for (let i = 0; i < prepared.length; i++) {
            for (let j = i + 1; j < prepared.length; j++) {
              pairs.push({
                a: i, b: j,
                same: prepared[i].forward === prepared[j].forward,
                c: corr(prepared[i].band, prepared[j].band),
                perBand: BANDS.map(function (_, k) {
                  return corr(prepared[i].bands[k], prepared[j].bands[k])
                })
              })
            }
          }

          // The same stacking test, per band: does averaging reinforce it or cancel it?
          const bandStacks = BANDS.map(function (_, k) {
            const acc = new Array(N).fill(0)
            for (const p of prepared) {
              for (let i = 0; i < N; i++) acc[i] += p.bands[k][i] / prepared.length
            }
            const meanOne =
              prepared.reduce(function (s, p) { return s + p.bandRms[k] }, 0) / prepared.length
            const stacked = d.spread(acc).rms
            const pos = []
            for (let i = 0; i < N; i++) pos.push(lo + step * i)
            return {
              name: BANDS[k].name,
              onePass: meanOne,
              stacked: stacked,
              kept: meanOne > 0 ? stacked / meanOne : 0,
              peak: d.spectrum(acc, pos, 1024).peak
            }
          })

          /*
           * The average of every pass, lined up by position.
           *
           * If the ripple is fixed to the glass, averaging reinforces it and the average keeps
           * roughly the size of one pass. If it is not, averaging cancels it and the average
           * shrinks towards nothing. That is a second, independent reading of the same
           * question, and it does not depend on picking a threshold for a correlation.
           */
          const stackedAll = new Array(N).fill(0)
          const stackedFwd = new Array(N).fill(0)
          let nf = 0
          for (const p of prepared) {
            for (let i = 0; i < N; i++) stackedAll[i] += p.band[i] / prepared.length
            if (p.forward) {
              nf++
              for (let i = 0; i < N; i++) stackedFwd[i] += p.band[i]
            }
          }
          if (nf > 0) for (let i = 0; i < N; i++) stackedFwd[i] /= nf

          return {
            samples: pts.length,
            angleDeg: (Math.atan2(ref.dy, ref.dx) * 180) / Math.PI,
            spanPx: hi - lo,
            passes: prepared.length,
            forwardCount: prepared.filter(function (p) { return p.forward }).length,
            perPass: prepared.map(function (p) {
              return { forward: p.forward, rms: p.rms, peak: p.peak }
            }),
            pairs: pairs,
            bandStacks: bandStacks,
            bandNames: BANDS.map(function (b) { return b.name }),
            meanPassRms: prepared.reduce(function (s, p) { return s + p.rms }, 0) / prepared.length,
            stackedAllRms: d.spread(stackedAll).rms,
            stackedForwardRms: nf > 0 ? d.spread(stackedFwd).rms : null,
            stackedForwardPeak: nf > 1
              ? d.spectrum(stackedFwd, stackedFwd.map(function (_, i) { return lo + step * i }), 1024).peak
              : null
          }
        })
        return { results: results }
      }.toString() +
      ')(' +
      JSON.stringify(fs.readFileSync(file, 'utf8')) +
      ')'
  )

  if (out.failed) {
    process.stderr.write(out.failed + '\n')
    app.exit(1)
    return
  }

  for (const r of out.results) {
    console.log('')
    if (r.tooFew) {
      console.log('  only ' + r.passes + ' usable pass found — needs at least two')
      continue
    }
    console.log('  ' + r.samples + ' distinct samples, ruler at ' + num(r.angleDeg, 1) + ' deg')
    console.log(
      '  ' + r.passes + ' passes over a shared ' + num(r.spanPx, 0) + ' px (' +
        r.forwardCount + ' one way, ' + (r.passes - r.forwardCount) + ' the other)'
    )
    console.log('')
    console.log('  per pass:')
    for (let i = 0; i < r.perPass.length; i++) {
      const p = r.perPass[i]
      const pk = p.peak && p.peak.prominence >= 15 && p.peak.wellSampled
        ? 'ripple every ' + num(p.peak.period) + ' px'
        : 'no clear period'
      console.log(
        '    ' + String(i).padEnd(3) + (p.forward ? '-->' : '<--') + '  ' +
          num(p.rms, 3) + ' px   ' + pk
      )
    }

    const same = r.pairs.filter((p) => p.same)
    const opp = r.pairs.filter((p) => !p.same)
    const mean = (a) => (a.length ? a.reduce((s, p) => s + p.c, 0) / a.length : null)
    const ms = mean(same)
    const mo = mean(opp)
    console.log('')
    console.log('  do the passes agree, lined up by position?')
    if (ms !== null) {
      console.log(
        '    same direction       ' + num(ms, 3) + '   (' + same.length + ' pairs, range ' +
          num(Math.min(...same.map((p) => p.c)), 2) + ' to ' +
          num(Math.max(...same.map((p) => p.c)), 2) + ')'
      )
    }
    if (mo !== null) {
      console.log(
        '    opposite direction   ' + num(mo, 3) + '   (' + opp.length + ' pairs, range ' +
          num(Math.min(...opp.map((p) => p.c)), 2) + ' to ' +
          num(Math.max(...opp.map((p) => p.c)), 2) + ')'
      )
    }

    if (r.bandNames) {
      console.log('')
      console.log('  the same question, split by scale:')
      for (let k = 0; k < r.bandNames.length; k++) {
        const sameB = same.length
          ? same.reduce((s, p) => s + p.perBand[k], 0) / same.length : null
        const oppB = opp.length ? opp.reduce((s, p) => s + p.perBand[k], 0) / opp.length : null
        const st = r.bandStacks[k]
        console.log('    ' + r.bandNames[k])
        console.log(
          '      agreement          same ' + num(sameB, 3) + ', reversed ' + num(oppB, 3)
        )
        console.log(
          '      size               ' + num(st.onePass, 3) + ' px per pass, ' +
            num(st.stacked, 3) + ' px averaged (' + num(st.kept * 100, 0) + '% kept)'
        )
        if (st.peak && st.peak.prominence >= 15 && st.peak.wellSampled) {
          console.log(
            '      period             every ' + num(st.peak.period) + ' px, ' +
              num(st.peak.amplitude, 3) + ' px'
          )
        }
      }
    }

    console.log('')
    console.log('  averaging the passes together:')
    console.log('    one pass on its own  ' + num(r.meanPassRms, 3) + ' px')
    if (r.stackedForwardRms !== null) {
      console.log('    one direction only   ' + num(r.stackedForwardRms, 3) + ' px')
    }
    console.log('    all passes           ' + num(r.stackedAllRms, 3) + ' px')
    const keptAll = r.stackedAllRms / r.meanPassRms
    console.log(
      '    survived averaging   ' + num(keptAll * 100, 0) + '% of one pass' +
        (keptAll > 0.6 ? '  — reinforced, so it is fixed to position'
          : keptAll < 0.35 ? '  — cancelled, so it is not fixed to position'
            : '  — partly reinforced')
    )
    if (r.stackedForwardPeak && r.stackedForwardPeak.prominence >= 15) {
      console.log(
        '    surviving ripple     every ' + num(r.stackedForwardPeak.period) + ' px, ' +
          num(r.stackedForwardPeak.amplitude, 3) + ' px'
      )
    }
  }
  console.log('')
  app.exit(0)
})
