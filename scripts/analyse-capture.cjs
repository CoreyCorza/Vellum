/**
 * Measure a saved capture file.
 *
 *   npx electron scripts/analyse-capture.cjs <file.json>
 *
 * Runs the same analyser the app uses, so nothing here can drift from what the panel
 * reports. Loading the app to do arithmetic looks odd, but the alternative is a second
 * copy of the analysis compiled for node, and two copies is how the numbers in the panel
 * and the numbers in a report start disagreeing.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')
const file = process.argv.find((a) => a.endsWith('.json'))

if (!file || !fs.existsSync(file)) {
  process.stderr.write('usage: electron scripts/analyse-capture.cjs <file.json>\n')
  process.exit(1)
}

const pad = (s, n) => String(s).padEnd(n)
const num = (v, n = 2) => (v === null || v === undefined ? '—' : v.toFixed(n))

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

  const payload = fs.readFileSync(file, 'utf8')
  const out = await win.webContents.executeJavaScript(
    '(' +
      function (text) {
        const d = window.diag
        if (!d || !d.report) return { failed: 'diag not exposed' }
        const parsed = JSON.parse(text)
        const held = ['still', '', 'hold', 'hover']
        return parsed.recorded.map(function (c, i) {
          const stationary = held.indexOf(c.label) >= 0 ? undefined : false
          const r = d.report(c, { stationary: stationary })
          const dev = d.deviation(c.raw)
          const press = c.raw.map(function (p) {
            return p.pressure
          })
          // Pressure differences between neighbouring samples: a steady push shows small
          // ones, a jittery sensor shows the same size step regardless of how hard you push.
          const steps = []
          for (let k = 1; k < press.length; k++) steps.push(press[k] - press[k - 1])
          const finest = press
            .slice(1)
            .map(function (v, k) {
              return Math.abs(v - press[k])
            })
            .filter(function (v) {
              return v > 1e-9
            })
            .sort(function (a, b) {
              return a - b
            })[0]
          return {
            i: i,
            label: c.label,
            source: c.source,
            viewScale: c.viewScale,
            samples: r.samples,
            rateHz: r.timing.rateHz,
            intervalMs: r.timing.meanIntervalMs,
            intervalSd: r.timing.sdIntervalMs,
            maxGapMs: r.timing.maxIntervalMs,
            repeats: r.timing.repeatedPositions,
            finestStep: r.timing.finestStep,
            treatedAs: r.treatedAs,
            wobbleRms: r.error.rms,
            wobblePeak: r.error.peak,
            wobbleSwing: r.error.peakToPeak,
            drawnRms: r.drawnError ? r.drawnError.rms : null,
            noise: r.noise,
            inTime: r.inTime,
            inDistance: r.inDistance,
            bySpeed: r.bySpeed,
            lengthPx: d.spread(dev.along).peakToPeak * (c.viewScale || 1),
            pressure: r.pressure,
            trimmed: r.trimmed
          }
        })
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
  console.log('  ' + path.basename(file))
  console.log('  ' + out.length + ' recordings')
  console.log('')
  console.log(
    '  ' + pad('#', 3) + pad('test', 10) + pad('samples', 9) + pad('rate', 8) +
      pad('interval', 16) + pad('finest', 9) + pad('repeated', 10) +
      pad('read as', 12)
  )
  console.log('  ' + '-'.repeat(76))
  for (const r of out) {
    console.log(
      '  ' + pad(r.i, 3) + pad(r.label || '(none)', 10) + pad(r.samples, 9) +
        pad(num(r.rateHz, 0) + 'Hz', 8) +
        pad(num(r.intervalMs) + ' +/- ' + num(r.intervalSd) + 'ms', 16) +
        pad(num(r.finestStep, 3) + 'px', 9) + pad(r.repeats + ' dup', 10) +
        pad(r.treatedAs, 12)
    )
  }

  for (const r of out) {
    console.log('')
    console.log('  --- ' + r.i + '  ' + (r.label || '(unlabelled)') + '  [' + r.treatedAs + ']')
    if (r.noise) {
      console.log('      noise sideways      ' + num(r.noise.sdX, 3) + ' px')
      console.log('      noise up/down       ' + num(r.noise.sdY, 3) + ' px')
      console.log('      noise overall       ' + num(r.noise.rms, 3) + ' px')
      console.log(
        '      worst swing         ' + num(r.noise.peakToPeakX, 2) + ' x ' +
          num(r.noise.peakToPeakY, 2) + ' px'
      )
      console.log('      distinct positions  ' + r.noise.distinctPositions + ' of ' + r.samples)
    } else {
      console.log('      line length         ' + num(r.lengthPx, 0) + ' px')
      console.log('      wobble typical      ' + num(r.wobbleRms, 3) + ' px')
      console.log('      wobble worst        ' + num(r.wobblePeak, 3) + ' px')
      console.log('      wobble full swing   ' + num(r.wobbleSwing, 3) + ' px')
      if (r.drawnRms !== null) {
        const cut = r.wobbleRms > 0 ? (1 - r.drawnRms / r.wobbleRms) * 100 : 0
        console.log(
          '      after stabiliser    ' + num(r.drawnRms, 3) + ' px  (' + num(cut, 0) + '% less)'
        )
      }
      for (const b of r.bySpeed) {
        console.log('      ' + pad(b.label, 20) + num(b.rmsError, 3) + ' px')
      }
    }
    const pat = (p, unit, what) => {
      if (!p) return console.log('      ' + pad(what, 20) + 'not measurable')
      if (p.prominence < 15) {
        return console.log(
          '      ' + pad(what, 20) + 'no pattern (prominence ' + num(p.prominence, 1) + ')'
        )
      }
      if (!p.wellSampled) {
        return console.log('      ' + pad(what, 20) + 'too fast for this sample rate')
      }
      console.log(
        '      ' + pad(what, 20) + 'every ' + num(p.period, 2) + ' ' + unit + ', ' +
          num(p.amplitude, 3) + ' px, prominence ' + num(p.prominence, 0)
      )
    }
    pat(r.inTime, 'sec', 'repeats in time')
    pat(r.inDistance, 'px', 'repeats in distance')
    const pr = r.pressure
    console.log('      pressure levels     ' + pr.levels)
    console.log('      pressure range      ' + num(pr.min, 4) + ' to ' + num(pr.max, 4))
    console.log(
      '      pressure step       typical ' + num(pr.stepRms, 5) + ', worst ' + num(pr.stepPeak, 5)
    )
    console.log(
      '      pressure jitter     ' + num(pr.jitterWhileStill * 100, 3) +
        '% while still, ' + num(pr.reversalsPerSecond, 0) + ' reversals/sec'
    )
    if (r.trimmed > 0) console.log('      trimmed ends        ' + r.trimmed + ' samples')
  }
  console.log('')
  app.exit(0)
})
