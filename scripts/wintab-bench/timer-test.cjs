/**
 * Does timeBeginPeriod(1) actually fix setInterval granularity in Electron's
 * main process? Measured, not assumed — the bench blamed a 15.6 ms tick for the
 * polling latency, so verify the remedy before asking anyone to draw again.
 */
const { app } = require('electron')
const koffi = require('koffi')

const winmm = koffi.load('winmm.dll')
const timeBeginPeriod = winmm.func('uint __stdcall timeBeginPeriod(uint uPeriod)')
const timeEndPeriod = winmm.func('uint __stdcall timeEndPeriod(uint uPeriod)')

function measure(requestedMs, samples = 400) {
  return new Promise((resolve) => {
    const gaps = []
    let last = performance.now()
    const t = setInterval(() => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (gaps.length >= samples) {
        clearInterval(t)
        gaps.sort((a, b) => a - b)
        const p = (q) => +gaps[Math.floor(gaps.length * q)].toFixed(2)
        resolve({
          requestedMs,
          p50: p(0.5),
          p95: p(0.95),
          mean: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)
        })
      }
    }, requestedMs)
  })
}

app.whenReady().then(async () => {
  const out = {}
  out.before = await measure(2)

  const rc = timeBeginPeriod(1)
  out.timeBeginPeriodResult = rc // 0 == TIMERR_NOERROR
  out.after = await measure(2)
  out.after1ms = await measure(1)
  timeEndPeriod(1)

  out.improvementFactor = +(out.before.p50 / out.after.p50).toFixed(1)
  // At 200 Hz a poll every <=5ms means at most ~1 packet waiting per poll.
  out.goodEnoughForPolling = out.after.p95 <= 5
  console.log('TIMER_TEST ' + JSON.stringify(out, null, 2))
  app.exit(out.goodEnoughForPolling ? 0 : 1)
})
