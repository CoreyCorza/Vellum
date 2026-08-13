/**
 * Build the correction, and prove it works before any of it goes near the live pen.
 *
 *   npx electron scripts/calibrate-axis.cjs <repeat-capture.json>
 *
 * The error has been shown to be a periodic function of x, fixed to the glass, the same in
 * both directions of travel. That makes it a systematic distortion rather than noise, and a
 * systematic distortion is subtracted, not filtered — which costs no latency at all.
 *
 * Being periodic makes the correction tiny. There is no need for a map of the whole tablet:
 * one period's worth of offsets, looked up by where x sits within that period, covers every
 * position on the surface. A couple of dozen numbers.
 *
 * The order of business here is deliberately conservative:
 *
 *   1. Recover the period, by folding the measured error at many candidate periods and
 *      keeping the one that adds up rather than cancelling out.
 *   2. Build the table from the folded average, which suppresses everything that is not
 *      locked to that period.
 *   3. Apply it to the recorded samples and measure what is left.
 *
 * Step 3 is the point. A correction that cannot reduce the ripple in a recording it was
 * fitted to is worthless, and one that reduces the ripple in a DIFFERENT pass from the one it
 * was fitted on is real. Both are reported, because the first is easy and the second is the
 * claim.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const file = process.argv.find((a) => a.endsWith('.json'))
if (!file || !fs.existsSync(file)) {
  process.stderr.write('usage: electron scripts/calibrate-axis.cjs <file.json>\n')
  process.exit(1)
}
const num = (v, n = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(n))

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

  const out = await win.webContents.executeJavaScript(
    '(' +
      function (text) {
        const d = window.diag
        if (!d || !d.report) return { failed: 'diag not exposed' }
        const parsed = JSON.parse(text)

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

        const c = parsed.recorded.filter(function (r) {
          return r.label === 'repeat' || r.raw.length > 4000
        })[0]
        if (!c) return { failed: 'no repeat recording' }
        const scale = c.viewScale > 0 ? c.viewScale : 1
        const pts = dedup(c.raw).map(function (p) {
          return { x: p.x * scale, y: p.y * scale, t: p.t, pressure: p.pressure, tilt: p.tilt,
                   twist: p.twist }
        })

        const ref = d.fitLine(pts)
        const theta = Math.atan2(ref.dy, ref.dx)
        const along = [], err = []
        for (let i = 0; i < pts.length; i++) {
          const ux = pts[i].x - ref.cx, uy = pts[i].y - ref.cy
          along.push(ux * ref.dx + uy * ref.dy)
          err.push(ux * -ref.dy + uy * ref.dx)
        }

        // Split into passes at the turns, same approach as the repeatability check.
        const smooth = avg(along, 40)
        const fullSpan = Math.max.apply(null, smooth) - Math.min.apply(null, smooth)
        const commit = fullSpan * 0.15
        const cuts = [0]
        let dir = 0, anchor = smooth[0]
        for (let i = 1; i < smooth.length; i++) {
          const move = smooth[i] - anchor
          if (dir === 0) {
            if (Math.abs(move) > commit) { dir = move > 0 ? 1 : -1; anchor = smooth[i] }
          } else if (move * dir < -commit) { cuts.push(i); dir = -dir; anchor = smooth[i] }
          else if (move * dir > 0) anchor = smooth[i]
        }
        cuts.push(smooth.length)

        const passes = []
        for (let k = 0; k + 1 < cuts.length; k++) {
          const a = cuts[k], b = cuts[k + 1]
          if (b - a < 200) continue
          const seg = []
          for (let i = a; i < b; i++) seg.push({ x: pts[i].x, y: pts[i].y, along: along[i], err: err[i] })
          const span = Math.max.apply(null, seg.map(function (s) { return s.along })) -
                       Math.min.apply(null, seg.map(function (s) { return s.along }))
          if (span < fullSpan * 0.6) continue
          passes.push(seg)
        }
        if (passes.length < 2) return { failed: 'need at least two passes' }

        /*
         * The sideways error on a tilted path, turned back into an error in x.
         *
         * A displacement of ex in x shows up sideways as ex times the sine of the angle, so
         * dividing by that sine recovers the x error the sideways wobble came from. Only the
         * ripple band is used, so the ruler's own long bow and the arm are left out.
         */
        /*
         * The sideways component of an x displacement is MINUS dy times it, because the
         * perpendicular direction is (-dy, dx). Getting that sign wrong produces a table that
         * is the exact negative of the correction, and subtracting it adds the error a second
         * time — which is what the first run did, reporting the ripple 13% worse.
         */
        const toXError = function (seg) {
          const sorted = seg.slice().sort(function (p, q) { return p.along - q.along })
          const e = sorted.map(function (p) { return p.err })
          // Tighter than before: anything slower than ~80 px is the ruler's bow or the arm,
          // and leaving it in biased the period search towards long periods, because a longer
          // fold soaks up more of whatever slow content survived.
          const wide = avg(e, Math.max(1, Math.round(80 / 2 / 1.1)))
          const band = avg(e.map(function (v, i) { return v - wide[i] }), 6)
          return sorted.map(function (p, i) { return { x: p.x, ex: -band[i] / ref.dy } })
        }
        const xErr = passes.map(toXError)

        /*
         * Which period? Folded at the right one the error reinforces; at a wrong one it
         * cancels. Scanning is more honest than trusting the spectrum's nearest bin, which is
         * quantised, and this is a fit of one number to thousands of samples.
         */
        const BINS = 24
        const fold = function (samples, period) {
          const sum = new Array(BINS).fill(0), n = new Array(BINS).fill(0)
          for (const s of samples) {
            let ph = s.x % period
            if (ph < 0) ph += period
            const b = Math.min(BINS - 1, Math.floor((ph / period) * BINS))
            sum[b] += s.ex
            n[b]++
          }
          const table = []
          for (let b = 0; b < BINS; b++) table.push(n[b] > 0 ? sum[b] / n[b] : 0)
          const mean = table.reduce(function (a, v) { return a + v }, 0) / BINS
          return table.map(function (v) { return v - mean })
        }
        const strength = function (table) {
          let s = 0
          for (const v of table) s += v * v
          return Math.sqrt(s / table.length)
        }

        const flat = [].concat.apply([], xErr)

        // Fit on some passes, test on the others. A table that only works on the data it was
        // built from has proved nothing.
        const fitIdx = [], testIdx = []
        for (let i = 0; i < xErr.length; i++) (i % 2 === 0 ? fitIdx : testIdx).push(i)
        const fitSamples = [].concat.apply([], fitIdx.map(function (i) { return xErr[i] }))

        const lookupFn = function (table, x, period) {
          let ph = x % period
          if (ph < 0) ph += period
          const t = (ph / period) * BINS
          const b0 = Math.floor(t) % BINS
          const b1 = (b0 + 1) % BINS
          const f = t - Math.floor(t)
          return table[b0] * (1 - f) + table[b1] * f
        }

        /*
         * Apply and re-measure. The correction moves x only, and then the sideways error is
         * recomputed from the corrected positions exactly as before — so this is the same
         * measurement, not a different one that happens to be smaller.
         */
        const rippleOf = function (seg, table, period) {
          const fixed = seg.map(function (p) {
            const x = table ? p.x - lookupFn(table, p.x, period) : p.x
            return { x: x, y: p.y }
          })
          const line = d.fitLine(fixed)
          const e = []
          for (const p of fixed) {
            e.push((p.x - line.cx) * -line.dy + (p.y - line.cy) * line.dx)
          }
          const wide = avg(e, 60)
          const band = avg(e.map(function (v, i) { return v - wide[i] }), 6)
          return d.spread(band).rms
        }

        /*
         * The period, chosen by what it actually achieves.
         *
         * Scored on the fit passes only, by how far subtracting the resulting table reduces
         * the ripple. An earlier version scored the size of the folded table instead, which
         * rewards long periods for soaking up whatever slow content survived the band-pass,
         * and duly picked 51 px over the 40 px that every independent measurement pointed at.
         */
        const scan = []
        let best = { period: 0, gain: -1e9 }
        for (let p = 25; p <= 90; p += 0.1) {
          const table = fold(fitSamples, p)
          let before = 0, after = 0
          for (const i of fitIdx) {
            before += rippleOf(passes[i], null, p)
            after += rippleOf(passes[i], table, p)
          }
          const gain = (before - after) / Math.max(1e-9, before)
          scan.push({ period: p, gain: gain })
          if (gain > best.gain) best = { period: p, gain: gain }
        }
        const tableFit = fold(fitSamples, best.period)
        const tableAll = fold(flat, best.period)

        const report = function (idx, table) {
          const before = idx.map(function (i) { return rippleOf(passes[i], null, best.period) })
          const after = idx.map(function (i) { return rippleOf(passes[i], table, best.period) })
          const mean = function (a) { return a.reduce(function (s, v) { return s + v }, 0) / a.length }
          return { before: mean(before), after: mean(after), n: idx.length }
        }

        return {
          angleDeg: (theta * 180) / Math.PI,
          samples: pts.length,
          passes: passes.length,
          period: best.period,
          gainOnFit: best.gain,
          tableAmplitude: strength(tableAll),
          tablePeakToPeak: Math.max.apply(null, tableAll) - Math.min.apply(null, tableAll),
          table: tableAll,
          scanNear: scan.filter(function (s) {
            return Math.abs(s.period - best.period) < 9 && Math.abs(Math.round(s.period) - s.period) < 0.06
          }).map(function (s) { return { p: s.period, s: s.gain } }),
          fittedOnAll: report(
            xErr.map(function (_, i) { return i }),
            tableAll
          ),
          fittedOnHalf: report(testIdx, tableFit),
          fitCount: fitIdx.length,
          testCount: testIdx.length
        }
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

  console.log('')
  console.log('  ruler at ' + num(out.angleDeg, 1) + ' deg, ' + out.passes + ' passes, ' +
    out.samples + ' distinct samples')
  console.log('')
  console.log('  the period, chosen by how much ripple subtracting it removes:')
  console.log('    best period          ' + num(out.period, 2) + ' px of x')
  const top = Math.max(...out.scanNear.map((s) => s.s), 0.001)
  for (const s of out.scanNear) {
    const bar = '#'.repeat(Math.max(0, Math.round((s.s / top) * 34)))
    console.log('      ' + num(s.p, 0).padStart(6) + ' px  ' + (s.s * 100).toFixed(0).padStart(4) + '%  ' + bar)
  }
  console.log('')
  console.log('  the correction table (' + out.table.length + ' entries, one period of x):')
  console.log('    size                 ' + num(out.tableAmplitude) + ' px typical, ' +
    num(out.tablePeakToPeak) + ' px peak to peak')
  const rows = []
  for (let i = 0; i < out.table.length; i += 8) {
    rows.push(out.table.slice(i, i + 8).map((v) => num(v, 3).padStart(7)).join(''))
  }
  for (const r of rows) console.log('     ' + r)

  const pct = (a, b) => ((1 - b / a) * 100).toFixed(0) + '%'
  console.log('')
  console.log('  ripple after subtracting it:')
  console.log(
    '    fitted on all passes ' + num(out.fittedOnAll.before) + ' -> ' +
      num(out.fittedOnAll.after) + ' px   (' +
      pct(out.fittedOnAll.before, out.fittedOnAll.after) + ' less)'
  )
  console.log(
    '    fitted on ' + out.fitCount + ', tested on the other ' + out.testCount + '   ' +
      num(out.fittedOnHalf.before) + ' -> ' + num(out.fittedOnHalf.after) + ' px   (' +
      pct(out.fittedOnHalf.before, out.fittedOnHalf.after) + ' less)'
  )
  console.log('')
  console.log('  the second line is the one that counts: those passes had no part in')
  console.log('  building the table.')
  console.log('')
  app.exit(0)
})
