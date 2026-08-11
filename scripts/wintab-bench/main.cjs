/**
 * Wintab vs Pointer Events bench.
 *
 *   npm run bench:wintab
 *
 * Opens a window with two live traces of the same stroke — one fed by Chromium's
 * Pointer Events (today's path) and one fed by Wintab packets polled in the main
 * process. Draw in it. Whichever dot leads is the lower-latency path, and the
 * readout quantifies rate, jitter and pressure resolution for both.
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('node:path')
const koffi = require('koffi')
const { Wintab } = require('./wintab.cjs')

const POLL_MS = Number(process.env.WINTAB_POLL_MS ?? 1)

/**
 * Raise the Windows timer resolution to 1 ms.
 *
 * Windows' default timer granularity is 15.6 ms, so `setInterval(2)` silently
 * becomes `setInterval(15.6)`. The first bench run measured exactly that:
 * 3.03 packets per poll at a 200 Hz device rate = 15.15 ms between polls, and
 * a 16.4 ms median added delay. Without this the polling strategy cannot be
 * judged on its merits — we would be measuring the scheduler, not the approach.
 *
 * Since Windows 10 2004 this is scoped to the requesting process rather than
 * global, so the power cost is ours alone.
 */
let timePeriodSet = false
function beginHighResolutionTimers() {
  try {
    const winmm = koffi.load('winmm.dll')
    const timeBeginPeriod = winmm.func('uint __stdcall timeBeginPeriod(uint uPeriod)')
    timePeriodSet = timeBeginPeriod(1) === 0 // TIMERR_NOERROR
    return timePeriodSet
  } catch {
    return false
  }
}
function endHighResolutionTimers() {
  if (!timePeriodSet) return
  try {
    const winmm = koffi.load('winmm.dll')
    winmm.func('uint __stdcall timeEndPeriod(uint uPeriod)')(1)
  } catch {
    /* nothing useful to do on exit */
  }
}

const highResTimers = beginHighResolutionTimers()
app.on('will-quit', endHighResolutionTimers)

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#141517',
    title: 'Wintab bench',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const wt = new Wintab()
  let caps = null
  let ctxInfo = null
  let error = null

  try {
    if (!wt.available()) throw new Error('Wintab reports unavailable (WTInfoW(0,0,NULL) == 0)')
    caps = wt.capabilities()
    ctxInfo = wt.open(win.getNativeWindowHandle())
  } catch (e) {
    error = String(e && e.message ? e.message : e)
  }

  const display = screen.getPrimaryDisplay()
  const scaleFactor = display.scaleFactor

  ipcMain.handle('bench:info', () => ({
    caps,
    ctxInfo,
    error,
    pollMs: POLL_MS,
    highResTimers,
    scaleFactor,
    contentBounds: win.getContentBounds()
  }))

  // --- polling loop ---------------------------------------------------------
  // setInterval is the simplest possible delivery. If its jitter turns out to
  // dominate the measurement, the alternative is a native addon with its own
  // thread — but that decision should be made from these numbers, not taste.
  let lastPollAt = performance.now()
  const timer = setInterval(() => {
    if (error) return
    const now = performance.now()
    const pollGap = now - lastPollAt
    lastPollAt = now

    const packets = wt.poll()
    if (packets.length === 0) return

    const bounds = win.getContentBounds()
    // Wintab gives physical screen pixels; Electron bounds are DIPs.
    const originX = bounds.x * scaleFactor
    const originY = bounds.y * scaleFactor

    const mapped = packets.map((p) => ({
      t: p.time,
      // to window-content CSS pixels
      x: (p.x - originX) / scaleFactor,
      y: (p.y - originY) / scaleFactor,
      pressure: p.pressure,
      buttons: p.buttons,
      azimuth: p.azimuth,
      altitude: p.altitude,
      twist: p.twist
    }))

    win.webContents.send('bench:packets', {
      packets: mapped,
      recvAt: now,
      batch: packets.length,
      pollGap
    })
  }, POLL_MS)

  win.on('closed', () => {
    clearInterval(timer)
    wt.close()
  })

  win.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', () => app.quit())
