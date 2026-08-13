/**
 * Whose error is the slow one — the tablet's, or the ruler's?
 *
 *   npx electron scripts/analyse-reversal.cjs <capture.json>
 *
 * Expects sweeps of nearly the same line: one with a straightedge, one with the SAME straightedge
 * turned end for end, and ideally one with a different straightedge entirely.
 *
 * The trick is borrowed from machinists, who have to calibrate a straightedge without already
 * owning a straighter one. Turning it end for end reverses its own bow along the line while
 * leaving everything about the machine where it was. So:
 *
 *   error that agrees at the same PLACE           belongs to the tablet
 *   error that agrees after reversing one profile belongs to the ruler
 *
 * Both comparisons are made on the same pair of recordings, which is what makes this decisive
 * rather than suggestive. It is reported separately for fast and slow content, because the fast
 * ripple has already been shown to be the tablet and the open question is entirely about the slow
 * part — the part that would feel like being led off a line rather than jittered.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const file = process.argv.find((a) => a.endsWith('.json'))
if (!file || !fs.existsSync(file)) {
  process.stderr.write('usage: electron scripts/analyse-reversal.cjs <file.json>\n')
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
        if (!d || !d.fitLine) return { failed: 'diag not exposed' }
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

        const sweeps = parsed.recorded
          .filter(function (c) { return c.raw.length > 800 })
          .map(function (c) {
            const s = c.viewScale > 0 ? c.viewScale : 1
            const cx = typeof c.viewX === 'number' ? c.viewX : 0
            const cy = typeof c.viewY === 'number' ? c.viewY : 0
            return dedup(c.raw).map(function (p) {
              return { x: (p.x - cx) * s, y: (p.y - cy) * s }
            })
          })
        if (sweeps.length < 2) return { failed: 'need at least two sweeps' }

        // One reference line for all of them, so every profile is measured in the same frame.
        const ref = d.fitLine([].concat.apply([], sweeps))

        const profileOf = function (pts) {
          const along = [], err = []
          for (let i = 0; i < pts.length; i++) {
            const ux = pts[i].x - ref.cx, uy = pts[i].y - ref.cy
            along.push(ux * ref.dx + uy * ref.dy)
            err.push(ux * -ref.dy + uy * ref.dx)
          }
          // Split at the turns and average the passes, which removes the hand and keeps whatever
          // is tied to position — the ruler's shape and the tablet's error together.
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
          const passes = []
          for (let k = 0; k + 1 < cuts.length; k++) {
            const a = cuts[k], b = cuts[k + 1]
            if (b - a < 150) continue
            const seg = []
            for (let i = a; i < b; i++) seg.push({ along: along[i], err: err[i] })
            const sp = Math.max.apply(null, seg.map(function (q) { return q.along })) -
                       Math.min.apply(null, seg.map(function (q) { return q.along }))
            if (sp < span * 0.6) continue
            seg.sort(function (p, q) { return p.along - q.along })
            passes.push(seg)
          }
          return { passes: passes, span: span }
        }

        const profs = sweeps.map(profileOf)
        if (profs.some(function (p) { return p.passes.length < 1 })) {
          return { failed: 'a sweep contained no usable pass' }
        }
        /*
         * A single pass per sweep is accepted, with a caveat attached to the reading.
         *
         * Averaging repeated passes is what removes the hand; with one pass the hand stays in, at
         * roughly the size of the thing being compared. Since it differs between sweeps it can only
         * dilute a correlation towards zero, never invent one, so a clear winner still means
         * something — but a weak result would be ambiguous rather than negative.
         */
        const singlePass = profs.every(function (p) { return p.passes.length === 1 })

        // Common grid over the span all of them share.
        let lo = -Infinity, hi = Infinity
        for (const pr of profs) {
          for (const seg of pr.passes) {
            lo = Math.max(lo, seg[0].along)
            hi = Math.min(hi, seg[seg.length - 1].along)
          }
        }
        if (!(hi - lo > 200)) return { failed: 'sweeps do not overlap enough' }
        const N = 1200
        const step = (hi - lo) / (N - 1)

        const sampled = profs.map(function (pr) {
          const acc = new Array(N).fill(0)
          for (const seg of pr.passes) {
            let j = 0
            for (let i = 0; i < N; i++) {
              const at = lo + step * i
              while (j < seg.length - 2 && seg[j + 1].along < at) j++
              const a0 = seg[j].along, a1 = seg[j + 1].along
              const f = a1 > a0 ? (at - a0) / (a1 - a0) : 0
              acc[i] += (seg[j].err + (seg[j + 1].err - seg[j].err) * f) / pr.passes.length
            }
          }
          // Remove offset and tilt only. The sweeps sit at slightly different lateral offsets and
          // angles, which says nothing about either the ruler or the tablet — but everything
          // curved is kept, because the curve is the entire question.
          let n = 0, si = 0, sv = 0, sii = 0, siv = 0
          for (let i = 0; i < N; i++) { n++; si += i; sv += acc[i]; sii += i * i; siv += i * acc[i] }
          const den = n * sii - si * si
          const slope = den !== 0 ? (n * siv - si * sv) / den : 0
          const inter = (sv - slope * si) / n
          return acc.map(function (v, i) { return v - inter - slope * i })
        })

        const bandSplit = function (v) {
          const wide = avg(v, Math.max(2, Math.round(80 / step / 2)))
          return {
            slow: wide,
            fast: avg(v.map(function (x, i) { return x - wide[i] }),
                      Math.max(1, Math.round(14 / step / 2)))
          }
        }
        const bands = sampled.map(bandSplit)

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
        const rev = function (a) { return a.slice().reverse() }
        const rms = function (a) {
          let s = 0
          for (const v of a) s += v * v
          return Math.sqrt(s / a.length)
        }

        const pairs = []
        for (let i = 0; i < bands.length; i++) {
          for (let j = i + 1; j < bands.length; j++) {
            pairs.push({
              a: i, b: j,
              slowSamePlace: corr(bands[i].slow, bands[j].slow),
              slowReversed: corr(bands[i].slow, rev(bands[j].slow)),
              fastSamePlace: corr(bands[i].fast, bands[j].fast),
              fastReversed: corr(bands[i].fast, rev(bands[j].fast))
            })
          }
        }

        return {
          singlePass: singlePass,
          sweeps: profs.map(function (p, i) { return { index: i, passes: p.passes.length } }),
          spanPx: hi - lo,
          sizes: bands.map(function (b) { return { slow: rms(b.slow), fast: rms(b.fast) } }),
          pairs: pairs
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

  const names = ['plastic', 'plastic flipped', 'wooden', 'fourth', 'fifth']
  console.log('')
  for (const s of out.sweeps) {
    console.log(
      '  ' + String(s.index) + '  ' + (names[s.index] || 'sweep ' + s.index) + ' — ' +
        s.passes + ' passes,  slow ' + num(out.sizes[s.index].slow) + ' px,  fast ' +
        num(out.sizes[s.index].fast) + ' px'
    )
  }
  console.log('  shared span ' + num(out.spanPx, 0) + ' px')
  if (out.singlePass) {
    console.log('')
    console.log('  NOTE: one pass per sweep, so the hand could not be averaged out. It is')
    console.log('  independent between sweeps, so it can only weaken a correlation, never')
    console.log('  manufacture one — a clear winner still counts, a weak one is ambiguous.')
  }

  console.log('')
  console.log('  SLOW content (the open question):')
  console.log('    pair                              same place   reversed   verdict')
  for (const p of out.pairs) {
    const same = p.slowSamePlace
    const revd = p.slowReversed
    const verdict =
      Math.abs(same) < 0.3 && Math.abs(revd) < 0.3
        ? 'neither — nothing shared'
        : same > revd + 0.15
          ? 'the TABLET'
          : revd > same + 0.15
            ? 'the RULER'
            : 'cannot separate'
    console.log(
      '    ' + ((names[p.a] || p.a) + ' vs ' + (names[p.b] || p.b)).padEnd(34) +
        num(same, 2).padStart(9) + num(revd, 2).padStart(11) + '   ' + verdict
    )
  }

  console.log('')
  console.log('  FAST ripple (already known to be the tablet — a control):')
  console.log('    pair                              same place   reversed')
  for (const p of out.pairs) {
    console.log(
      '    ' + ((names[p.a] || p.a) + ' vs ' + (names[p.b] || p.b)).padEnd(34) +
        num(p.fastSamePlace, 2).padStart(9) + num(p.fastReversed, 2).padStart(11)
    )
  }
  console.log('')
  app.exit(0)
})
