/**
 * Build a correction from a calibration capture and score it on the check strokes.
 *
 *   npx electron scripts/build-correction.cjs <calibration.json> [--save <out.json>]
 *
 * The calibration passes ('cal-h', 'cal-v') build the tables. The check strokes ('check') are
 * never used to build anything, so what happens to them is the only honest measure of whether
 * this works. Both numbers are printed, because a table always flatters the data it came from.
 *
 * Also reported with the correction switched to the WRONG axis. If correcting x with a table
 * built for y helped, that would mean the improvement came from the smoothing hidden in the
 * measurement rather than from cancelling a real error, and the whole claim would be empty.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const file = process.argv.find((a) => a.endsWith('.json') && !a.includes('--'))
const saveAt = process.argv.includes('--save')
  ? process.argv[process.argv.indexOf('--save') + 1]
  : null

if (!file || !fs.existsSync(file)) {
  process.stderr.write('usage: electron scripts/build-correction.cjs <file.json> [--save out.json]\n')
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

  const out = await win.webContents.executeJavaScript(
    '(' +
      function (text) {
        const d = window.diag
        if (!d || !d.buildAxisTable) return { failed: 'correction not exposed' }
        const parsed = JSON.parse(text)

        const toScreen = function (c) {
          const s = c.viewScale > 0 ? c.viewScale : 1
          return c.raw.map(function (p) {
            return { t: p.t, x: p.x * s, y: p.y * s, pressure: p.pressure, tilt: p.tilt,
                     twist: p.twist }
          })
        }
        const pick = function (label) {
          return parsed.recorded.filter(function (c) { return c.label === label }).map(toScreen)
        }

        const calH = pick('cal-h')
        const calV = pick('cal-v')
        const checks = pick('check')
        if (calH.length === 0 && calV.length === 0) return { failed: 'no calibration passes' }

        const build = function (hs, vs) {
          return {
            x: hs.length ? d.buildAxisTable(hs.map(function (p) { return d.axisWiggle(p, 'x') }), 4) : null,
            y: vs.length ? d.buildAxisTable(vs.map(function (p) { return d.axisWiggle(p, 'y') }), 4) : null
          }
        }

        const full = build(calH, calV)

        // Half the passes, so the tables can be scored on calibration passes they never saw
        // as well as on the check strokes.
        const evens = function (a) { return a.filter(function (_, i) { return i % 2 === 0 }) }
        const odds = function (a) { return a.filter(function (_, i) { return i % 2 === 1 }) }
        const half = build(evens(calH), evens(calV))

        const describe = function (t) {
          if (!t) return null
          let lo = Infinity, hi = -Infinity, covered = 0, sq = 0, n = 0
          for (let i = 0; i < t.offsets.length; i++) {
            if (t.weight[i] < 8) continue
            covered++
            sq += t.offsets[i] * t.offsets[i]
            n++
            const v = t.origin + i * t.step
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
          return {
            bins: t.offsets.length,
            covered: covered,
            step: t.step,
            from: lo, to: hi,
            rms: n ? Math.sqrt(sq / n) : 0,
            peakToPeak: Math.max.apply(null, t.offsets) - Math.min.apply(null, t.offsets)
          }
        }

        const score = function (strokes, corr) {
          return strokes.map(function (p) {
            const s = d.scoreCorrection(p, corr)
            const line = d.fitLine(p)
            return {
              angleDeg: (Math.atan2(line.dy, line.dx) * 180) / Math.PI,
              samples: p.length,
              before: s.before, after: s.after, removed: s.removed
            }
          })
        }

        return {
          counts: { calH: calH.length, calV: calV.length, checks: checks.length },
          tableX: describe(full.x),
          tableY: describe(full.y),
          checksFull: score(checks, full),
          checksHalf: score(checks, half),
          heldOutCal: score(odds(calH), half),
          // The control: x corrected with y's table and vice versa. Should do nothing useful.
          checksSwapped: score(checks, { x: full.y, y: full.x }),
          saved: { x: full.x, y: full.y, note: 'built from ' + calH.length + ' horizontal and ' +
                   calV.length + ' vertical passes' }
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

  const tbl = (name, t) => {
    if (!t) {
      console.log('  ' + name + ': none')
      return
    }
    console.log(
      '  ' + name + ': ' + t.covered + ' of ' + t.bins + ' bins covered, ' + t.step +
        ' px each, ' + num(t.from, 0) + ' to ' + num(t.to, 0)
    )
    console.log(
      '    size ' + num(t.rms) + ' px typical, ' + num(t.peakToPeak) + ' px peak to peak'
    )
  }

  console.log('')
  console.log(
    '  ' + out.counts.calH + ' horizontal, ' + out.counts.calV + ' vertical, ' +
      out.counts.checks + ' check strokes'
  )
  console.log('')
  console.log('  the measured distortion:')
  tbl('x', out.tableX)
  tbl('y', out.tableY)

  const table = (rows, label) => {
    console.log('')
    console.log('  ' + label)
    for (const r of rows) {
      console.log(
        '    ' + (num(r.angleDeg, 0) + ' deg').padEnd(9) + num(r.before) + ' -> ' +
          num(r.after) + ' px   ' + pct(r.removed).padStart(7)
      )
    }
    const mean = rows.reduce((s, r) => s + r.removed, 0) / Math.max(1, rows.length)
    console.log('    ' + 'mean'.padEnd(9) + ' '.repeat(20) + pct(mean).padStart(7))
    return mean
  }

  const a = table(out.checksFull, 'check strokes, table built from ALL calibration passes:')
  const b = table(out.checksHalf, 'check strokes, table built from HALF the passes:')
  const c = table(out.heldOutCal, 'calibration passes left out of the table:')
  const s = table(out.checksSwapped, 'control — x corrected with the y table and vice versa:')

  console.log('')
  console.log('  reading:')
  if (b > 0.1 && b > s + 0.08) {
    console.log('    the correction removes ripple from strokes it was never built from,')
    console.log('    and swapping the axes does not, so it is cancelling a real error')
    console.log('    rather than smoothing.')
  } else if (b > 0.1) {
    console.log('    it improves the check strokes, but the swapped control improves them')
    console.log('    almost as much — which means some of the gain is smoothing, not')
    console.log('    correction. Not yet trustworthy.')
  } else {
    console.log('    no useful improvement on strokes it was not built from.')
  }

  if (saveAt && out.saved) {
    fs.writeFileSync(saveAt, JSON.stringify(out.saved, null, 1), 'utf8')
    console.log('')
    console.log('  saved the tables to ' + saveAt)
  }
  console.log('')
  app.exit(0)
})
