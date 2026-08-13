/**
 * Fit the digitiser's distortion from diagonal sweeps.
 *
 *   npx electron scripts/fit-distortion.cjs <capture.json> [more.json ...]
 *
 * The along-track channel turned out to be unusable: a real arm varies its speed by about a
 * pixel, the distortion is a third of that, and no realistic number of passes separates them.
 * Sideways error on a ruler pass is a far better channel, because the straightedge holds the
 * hand still in exactly the direction being measured — measured at 99% repeatable, against
 * roughly nothing for the along-track version.
 *
 * Sideways error mixes the two axes, so one diagonal is not enough:
 *
 *   sideways error = -(x error) * sin(angle) + (y error) * cos(angle)
 *
 * Two diagonals at opposite angles give two different mixtures of the same two unknowns, and
 * both fall out. This fits them together rather than solving pair by pair, because the strokes
 * do not cross the same points.
 *
 * The third term matters as much as the other two. A physical straightedge is not straight, and
 * its bow is fixed to position exactly like a sensor error — indistinguishable on one ruler. But
 * a bow belongs to the ruler and moves with it, while the digitiser's error stays with the
 * glass, so each stroke gets its own smooth nuisance term and only what is common to both
 * strokes is attributed to the tablet.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
// The path after --save is an output, not another capture to read.
const saveIdx = process.argv.indexOf('--save')
const saveAt = saveIdx >= 0 ? process.argv[saveIdx + 1] : null
const files = process.argv.filter((a) => a.endsWith('.json') && a !== saveAt)
if (files.length === 0) {
  process.stderr.write('usage: electron scripts/fit-distortion.cjs <file.json> [...]\n')
  process.exit(1)
}
const num = (v, n = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(n))
const pct = (v) => (v * 100).toFixed(1) + '%'

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 2000))

  // How much freedom each ruler's own shape gets, and how wide a band to judge over.
  const bowArg = process.argv.indexOf('--bow')
  const bandArg = process.argv.indexOf('--band')
  const bowOrder = bowArg >= 0 ? process.argv[bowArg + 1] : '2'
  const bandLow = bandArg >= 0 ? process.argv[bandArg + 1] : '80'
  await win.webContents.executeJavaScript(
    'window.__bowOrder = ' + (bowOrder === 'free' ? 'null' : bowOrder) +
      '; window.__bandLow = ' + (bandLow === 'all' ? 'null' : bandLow) + '; 1'
  )
  console.log('  ruler shape allowed: ' + (bowOrder === 'free' ? 'any smooth curve' : 'order ' + bowOrder) +
    ',  judged over: ' + (bandLow === 'all' ? 'every scale' : 'under ' + bandLow + ' px'))

  const payload = files.map((f) => fs.readFileSync(f, 'utf8'))

  const out = await win.webContents.executeJavaScript(
    '(' +
      function (texts) {
        const d = window.diag
        if (!d || !d.buildAxisTable) return { failed: 'correction not exposed' }

        const dedup = function (pts) {
          const o = []
          for (let i = 0; i < pts.length; i++) {
            const q = o[o.length - 1]
            if (!q || pts[i].x !== q.x || pts[i].y !== q.y) o.push(pts[i])
          }
          return o
        }
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

        // Every stroke that sweeps a ruler, from every file handed in.
        const strokes = []
        for (const text of texts) {
          const parsed = JSON.parse(text)
          for (const c of parsed.recorded) {
            /*
             * Any recording that turns out to contain repeated full-length passes over one line
             * is a ruler sweep, whatever it was labelled. The label is a hint about intent; the
             * shape of the stroke is the evidence, and the pass splitter downstream discards
             * anything that is not a sweep.
             */
            if (c.label === 'still' || c.label === 'hover' || c.label === 'braced' ||
                c.label === 'press') continue
            /*
             * Into a frame fixed to the GLASS, not to the document.
             *
             * The distortion belongs to the digitiser, so two recordings only line up if their
             * coordinates refer to the same physical place. Document coordinates do not: they
             * move with the zoom and with wherever the canvas was panned to. One capture here
             * was taken at 97% zoom with a different pan from the others, and combining them
             * without this dropped the result from 41% to 23% — the tables were being averaged
             * across two different maps.
             *
             * Measured from the viewport centre, which is a fixed offset from a screen position
             * for a given window, and cancels out of everything done with it.
             */
            const s = c.viewScale > 0 ? c.viewScale : 1
            const cx = typeof c.viewX === 'number' ? c.viewX : 0
            const cy = typeof c.viewY === 'number' ? c.viewY : 0
            const pts = dedup(c.raw).map(function (p) {
              return { x: (p.x - cx) * s, y: (p.y - cy) * s }
            })
            if (pts.length < 400) continue
            strokes.push({ label: c.label, pts: pts, zoom: s })
          }
        }
        if (strokes.length < 2) return { failed: 'need at least two ruler strokes' }

        // Split a continuous sweep into its individual passes.
        const splitPasses = function (pts, line) {
          const along = pts.map(function (p) {
            return (p.x - line.cx) * line.dx + (p.y - line.cy) * line.dy
          })
          const sm = avg(along, 40)
          const span = Math.max.apply(null, sm) - Math.min.apply(null, sm)
          const commit = span * 0.15
          const cuts = [0]
          let dir = 0, anchor = sm[0]
          for (let i = 1; i < sm.length; i++) {
            const move = sm[i] - anchor
            if (dir === 0) {
              if (Math.abs(move) > commit) { dir = move > 0 ? 1 : -1; anchor = sm[i] }
            } else if (move * dir < -commit) { cuts.push(i); dir = -dir; anchor = sm[i] }
            else if (move * dir > 0) anchor = sm[i]
          }
          cuts.push(sm.length)
          const out = []
          for (let k = 0; k + 1 < cuts.length; k++) {
            const a = cuts[k], b = cuts[k + 1]
            if (b - a < 200) continue
            const seg = []
            for (let i = a; i < b; i++) seg.push({ x: pts[i].x, y: pts[i].y, along: along[i] })
            const sp = Math.max.apply(null, seg.map(function (q) { return q.along })) -
                       Math.min.apply(null, seg.map(function (q) { return q.along }))
            if (sp < span * 0.6) continue
            out.push(seg)
          }
          return out
        }

        // Prepare each stroke: its line, its passes, and each pass's sideways error.
        const prepared = strokes.map(function (st) {
          const line = d.fitLine(st.pts)
          const passes = splitPasses(st.pts, line).map(function (seg) {
            const sorted = seg.slice().sort(function (p, q) { return p.along - q.along })
            const err = sorted.map(function (p) {
              return (p.x - line.cx) * -line.dy + (p.y - line.cy) * line.dx
            })
            return { pts: sorted, err: err }
          })
          return {
            label: st.label,
            zoom: st.zoom,
            line: line,
            angleDeg: (Math.atan2(line.dy, line.dx) * 180) / Math.PI,
            passes: passes
          }
        })
        const usable = prepared.filter(function (p) { return p.passes.length >= 2 })
        if (usable.length < 2) return { failed: 'need two strokes with repeated passes' }

        /*
         * Average the passes of one stroke together, by position along the ruler.
         *
         * This is the step that makes the whole thing possible. The hand is not tied to
         * position and averages away; the distortion and the ruler's bow both are, and survive.
         * Five passes measured 99% retention, so this is close to free.
         */
        const profileOf = function (stroke, which) {
          const passes = which.map(function (i) { return stroke.passes[i] })
          const lo = Math.max.apply(null, passes.map(function (p) { return p.pts[0].along }))
          const hi = Math.min.apply(null, passes.map(function (p) {
            return p.pts[p.pts.length - 1].along
          }))
          /*
           * Dense enough that every bin gets real evidence.
           *
           * At 900 points a 1300 px sweep put barely one sample in each 4 px bin, so almost
           * every x bin fell under the minimum weight and was suppressed — the x correction was
           * switched off and the y table was doing all the work while appearing to share it.
           * Each point here is already the average of several passes, so density costs nothing
           * but arithmetic.
           */
          const N = 2600
          if (!(hi - lo > 100)) return null
          const step = (hi - lo) / (N - 1)
          const acc = new Array(N).fill(0)
          const accX = new Array(N).fill(0)
          const accY = new Array(N).fill(0)
          for (const p of passes) {
            let j = 0
            for (let i = 0; i < N; i++) {
              const at = lo + step * i
              while (j < p.pts.length - 2 && p.pts[j + 1].along < at) j++
              const a0 = p.pts[j].along, a1 = p.pts[j + 1].along
              const f = a1 > a0 ? (at - a0) / (a1 - a0) : 0
              acc[i] += (p.err[j] + (p.err[j + 1] - p.err[j]) * f) / passes.length
              accX[i] += (p.pts[j].x + (p.pts[j + 1].x - p.pts[j].x) * f) / passes.length
              accY[i] += (p.pts[j].y + (p.pts[j + 1].y - p.pts[j].y) * f) / passes.length
            }
          }
          return { err: acc, x: accX, y: accY, step: step, dx: stroke.line.dx, dy: stroke.line.dy,
                   zoom: stroke.zoom }
        }

        const evens = function (n) {
          const a = []
          for (let i = 0; i < n; i += 2) a.push(i)
          return a
        }
        const odds = function (n) {
          const a = []
          for (let i = 1; i < n; i += 2) a.push(i)
          return a
        }

        /*
         * Fit the two axis tables plus one smooth bow per stroke, by alternating.
         *
         * The bow soaks up anything slower than the ripple, which is where a straightedge's own
         * shape lives. Attributing that to the tablet would be the easiest possible way to
         * produce an impressive-looking table full of the ruler.
         */
        const BIN = 4

        /*
         * What shape a ruler's own error is allowed to be.
         *
         * A free smoothed curve per stroke, which is what this did first, can absorb ANY slow
         * content — including slow distortion that the tablet shares across every stroke. That
         * throws away exactly the part that would feel like being led off the line rather than
         * jittered, and it was thrown away on purpose to avoid mistaking a bowed ruler for a bent
         * digitiser.
         *
         * A low-order polynomial is the honest compromise. A straightedge bows; it does not
         * undulate. Restricting it to a bow leaves shared slow content nowhere to go except the
         * axis tables, where it belongs, while still keeping each ruler's own shape out of them.
         */
        /*
         * Free by default, after measuring both. Restricting the ruler to a bow in the hope of
         * recovering slow distortion did not help: 58% held out against 60% with a free curve
         * inside the ripple band, and judged across every scale the correction only reaches 35 to
         * 39% however the ruler is constrained. So the slow component is not being separated, and
         * attributing it to the tablet on this evidence would inject a slow warp into every stroke
         * — worse than the problem. It stays out until it can be told apart from the rulers.
         */
        const BOW_ORDER = window.__bowOrder === undefined ? null : window.__bowOrder

        /** Least squares polynomial of a given order, evaluated back over the same samples. */
        const polyFit = function (v, order) {
          const n = v.length
          const m = order + 1
          // Normal equations on a centred, scaled index, so the powers stay well conditioned.
          const A = []
          for (let r = 0; r < m; r++) A.push(new Array(m + 1).fill(0))
          const tOf = function (i) { return (2 * i) / (n - 1) - 1 }
          for (let i = 0; i < n; i++) {
            const t = tOf(i)
            const pow = [1]
            for (let k = 1; k < 2 * m; k++) pow.push(pow[k - 1] * t)
            for (let r = 0; r < m; r++) {
              for (let c = 0; c < m; c++) A[r][c] += pow[r + c]
              A[r][m] += pow[r] * v[i]
            }
          }
          // Gaussian elimination; m is 3 or 4, so this is nothing.
          for (let r = 0; r < m; r++) {
            let piv = r
            for (let k = r + 1; k < m; k++) if (Math.abs(A[k][r]) > Math.abs(A[piv][r])) piv = k
            const tmp = A[r]; A[r] = A[piv]; A[piv] = tmp
            if (Math.abs(A[r][r]) < 1e-12) continue
            for (let k = r + 1; k < m; k++) {
              const f = A[k][r] / A[r][r]
              for (let c = r; c <= m; c++) A[k][c] -= f * A[r][c]
            }
          }
          const coef = new Array(m).fill(0)
          for (let r = m - 1; r >= 0; r--) {
            let acc = A[r][m]
            for (let c = r + 1; c < m; c++) acc -= A[r][c] * coef[c]
            coef[r] = Math.abs(A[r][r]) < 1e-12 ? 0 : acc / A[r][r]
          }
          const out = new Array(n)
          for (let i = 0; i < n; i++) {
            const t = tOf(i)
            let acc = 0
            let pw = 1
            for (let r = 0; r < m; r++) { acc += coef[r] * pw; pw *= t }
            out[i] = acc
          }
          return out
        }
        const fit = function (profiles, iterations) {
          let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity
          for (const p of profiles) {
            for (const v of p.x) { if (v < xLo) xLo = v; if (v > xHi) xHi = v }
            for (const v of p.y) { if (v < yLo) yLo = v; if (v > yHi) yHi = v }
          }
          const nx = Math.ceil((xHi - xLo) / BIN) + 1
          const ny = Math.ceil((yHi - yLo) / BIN) + 1
          let ex = new Array(nx).fill(0)
          let ey = new Array(ny).fill(0)
          const wx = new Array(nx).fill(0)
          const wy = new Array(ny).fill(0)
          const bows = profiles.map(function (p) { return new Array(p.err.length).fill(0) })

          const ixOf = function (v) { return Math.min(nx - 1, Math.max(0, Math.round((v - xLo) / BIN))) }
          const iyOf = function (v) { return Math.min(ny - 1, Math.max(0, Math.round((v - yLo) / BIN))) }

          for (let it = 0; it < iterations; it++) {
            // bow: whatever is left after the axis model, smoothed over a window well wider
            // than the ripple so it cannot absorb it.
            for (let s = 0; s < profiles.length; s++) {
              const p = profiles[s]
              const resid = p.err.map(function (e, i) {
                return e - (-ex[ixOf(p.x[i])] * p.dy + ey[iyOf(p.y[i])] * p.dx)
              })
              bows[s] = BOW_ORDER === null
                ? avg(resid, Math.max(2, Math.round(140 / p.step / 2)))
                : polyFit(resid, BOW_ORDER)
            }
            // ex, from the residual with the bow and the current ey removed.
            const sx = new Array(nx).fill(0)
            wx.fill(0)
            for (let s = 0; s < profiles.length; s++) {
              const p = profiles[s]
              if (Math.abs(p.dy) < 0.2) continue
              for (let i = 0; i < p.err.length; i++) {
                const r = p.err[i] - bows[s][i] - ey[iyOf(p.y[i])] * p.dx
                const b = ixOf(p.x[i])
                sx[b] += -r / p.dy
                wx[b]++
              }
            }
            ex = sx.map(function (v, i) { return wx[i] > 0 ? v / wx[i] : 0 })
            // ey, likewise.
            const sy = new Array(ny).fill(0)
            wy.fill(0)
            for (let s = 0; s < profiles.length; s++) {
              const p = profiles[s]
              if (Math.abs(p.dx) < 0.2) continue
              for (let i = 0; i < p.err.length; i++) {
                const r = p.err[i] - bows[s][i] + ex[ixOf(p.x[i])] * p.dy
                const b = iyOf(p.y[i])
                sy[b] += r / p.dx
                wy[b]++
              }
            }
            ey = sy.map(function (v, i) { return wy[i] > 0 ? v / wy[i] : 0 })
          }

          // A constant or a slope in either table would shift or stretch the whole drawing, and
          // neither was measured — both are artefacts of a finite fit.
          const detrend = function (t, w) {
            let n = 0, si = 0, sv = 0, sii = 0, siv = 0
            for (let i = 0; i < t.length; i++) {
              if (w[i] < 8) continue
              n++; si += i; sv += t[i]; sii += i * i; siv += i * t[i]
            }
            if (n < 2) return t
            const den = n * sii - si * si
            const slope = den !== 0 ? (n * siv - si * sv) / den : 0
            const inter = (sv - slope * si) / n
            return t.map(function (v, i) { return v - inter - slope * i })
          }

          return {
            x: { step: BIN, origin: xLo, offsets: detrend(ex, wx), weight: wx },
            y: { step: BIN, origin: yLo, offsets: detrend(ey, wy), weight: wy }
          }
        }

        // Fit on even passes, score on odd ones.
        const fitProfiles = usable.map(function (s) { return profileOf(s, evens(s.passes.length)) })
          .filter(Boolean)
        const testProfiles = usable.map(function (s) { return profileOf(s, odds(s.passes.length)) })
          .filter(Boolean)
        if (fitProfiles.length < 2 || testProfiles.length < 2) {
          return { failed: 'not enough passes to split into fit and test' }
        }

        const corr = fit(fitProfiles, 6)
        const corrAll = fit(
          usable.map(function (s) {
            const all = []
            for (let i = 0; i < s.passes.length; i++) all.push(i)
            return profileOf(s, all)
          }).filter(Boolean),
          6
        )

        // Score a profile: ripple in the band, before and after correcting the positions.
        const BAND_LOW = window.__bandLow === undefined ? 80 : window.__bandLow
        const band = function (values, step) {
          const wide = BAND_LOW === null
            ? values.map(function () { return 0 })
            : avg(values, Math.max(2, Math.round(BAND_LOW / step / 2)))
          return avg(values.map(function (v, i) { return v - wide[i] }), Math.max(1, Math.round(14 / step / 2)))
        }
        const rms = function (a) {
          let s = 0
          for (const v of a) s += v * v
          return Math.sqrt(s / a.length)
        }
        const scoreProfile = function (p, table) {
          const before = band(p.err, p.step)
          const fixedErr = p.err.map(function (e, i) {
            const ox = table.x ? d.offsetAt(table.x, p.x[i]) : 0
            const oy = table.y ? d.offsetAt(table.y, p.y[i]) : 0
            // Removing ox from x and oy from y removes (-ox*dy + oy*dx) from the sideways error.
            return e - (-ox * p.dy + oy * p.dx)
          })
          const after = band(fixedErr, p.step)
          return { before: rms(before), after: rms(after), removed: 1 - rms(after) / rms(before) }
        }

        const describe = function (t) {
          let sq = 0, n = 0, cov = 0
          for (let i = 0; i < t.offsets.length; i++) {
            if (t.weight[i] < 8) continue
            sq += t.offsets[i] * t.offsets[i]; n++; cov++
          }
          return {
            bins: t.offsets.length, covered: cov,
            rms: n ? Math.sqrt(sq / n) : 0,
            peakToPeak: Math.max.apply(null, t.offsets) - Math.min.apply(null, t.offsets)
          }
        }

        return {
          strokes: usable.map(function (s, i) {
            return { label: s.label, angleDeg: s.angleDeg, passes: s.passes.length }
          }),
          tableX: describe(corr.x),
          tableY: describe(corr.y),
          heldOut: testProfiles.map(function (p, i) {
            return Object.assign({ angle: (Math.atan2(p.dy, p.dx) * 180) / Math.PI, zoom: p.zoom },
              scoreProfile(p, corr))
          }),
          onFit: fitProfiles.map(function (p) {
            return Object.assign({ angle: (Math.atan2(p.dy, p.dx) * 180) / Math.PI },
              scoreProfile(p, corr))
          }),
          // Control: the y table used for x and vice versa. Should not help.
          swapped: testProfiles.map(function (p) {
            return Object.assign({ angle: (Math.atan2(p.dy, p.dx) * 180) / Math.PI },
              scoreProfile(p, { x: corr.y, y: corr.x }))
          }),
          saved: { x: corrAll.x, y: corrAll.y, note: 'fitted from diagonal sweeps' }
        }
      }.toString() +
      ')(' +
      JSON.stringify(payload) +
      ')'
  )

  if (out.failed) {
    process.stderr.write(out.failed + '\n')
    app.exit(1)
    return
  }

  console.log('')
  for (const s of out.strokes) {
    console.log('  ' + s.label + ' at ' + num(s.angleDeg, 1) + ' deg, ' + s.passes + ' passes')
  }
  console.log('')
  console.log('  fitted distortion:')
  console.log(
    '    x  ' + out.tableX.covered + '/' + out.tableX.bins + ' bins, ' + num(out.tableX.rms) +
      ' px typical, ' + num(out.tableX.peakToPeak) + ' px peak to peak'
  )
  console.log(
    '    y  ' + out.tableY.covered + '/' + out.tableY.bins + ' bins, ' + num(out.tableY.rms) +
      ' px typical, ' + num(out.tableY.peakToPeak) + ' px peak to peak'
  )

  const show = (rows, label) => {
    console.log('')
    console.log('  ' + label)
    for (const r of rows) {
      console.log(
        '    ' + (num(r.angle, 0) + ' deg').padEnd(9) +
          (r.zoom ? ('zoom ' + num(r.zoom, 2)).padEnd(11) : '') +
          num(r.before) + ' -> ' + num(r.after) + ' px   ' + pct(r.removed).padStart(8)
      )
    }
    const m = rows.reduce((s, r) => s + r.removed, 0) / Math.max(1, rows.length)
    console.log('    ' + 'mean'.padEnd(9) + ' '.repeat(21) + pct(m).padStart(8))
    return m
  }

  show(out.onFit, 'passes used to fit (flattering by construction):')
  const held = show(out.heldOut, 'passes HELD OUT of the fit:')
  const swap = show(out.swapped, 'control, axes swapped:')

  console.log('')
  console.log('  reading:')
  if (held > 0.3 && held > swap + 0.2) {
    console.log('    the correction removes most of the ripple from passes it never saw,')
    console.log('    and the swapped control does not. This is worth wiring into the pen.')
  } else if (held > 0.15 && held > swap + 0.1) {
    console.log('    a real but partial improvement on held-out passes, clearly better than')
    console.log('    the control. Worth pursuing with more sweeps.')
  } else {
    console.log('    not convincing on held-out passes.')
  }
  if (saveAt && out.saved) {
    fs.writeFileSync(saveAt, JSON.stringify(out.saved), 'utf8')
    console.log('  saved the correction to ' + saveAt)
  }
  console.log('')
  app.exit(0)
})
