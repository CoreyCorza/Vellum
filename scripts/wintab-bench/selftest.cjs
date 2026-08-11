/**
 * Headless check that a Wintab context can actually be opened against a real
 * HWND. Packets need a pen in motion, so this proves plumbing only:
 * capabilities read, WTOpenW succeeds, queue sized, poll returns cleanly.
 */
const { app, BrowserWindow } = require('electron')
const { Wintab } = require('./wintab.cjs')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false })
  const out = {}
  const wt = new Wintab()
  try {
    out.available = wt.available()
    out.caps = wt.capabilities()
    out.ctx = wt.open(win.getNativeWindowHandle())
    // Poll a few times; zero packets is the expected result with no pen moving.
    let polls = 0
    let packets = 0
    for (let i = 0; i < 25; i++) {
      packets += wt.poll().length
      polls++
      await new Promise((r) => setTimeout(r, 4))
    }
    out.polls = polls
    out.packetsWhileIdle = packets
    out.pollDidNotThrow = true
    wt.close()
    out.closed = true
  } catch (e) {
    out.error = String(e && e.message ? e.message : e)
  }
  out.failed = !(out.available && out.ctx && out.pollDidNotThrow && out.closed)
  console.log('WINTAB_SELFTEST ' + JSON.stringify(out, null, 2))
  app.exit(out.failed ? 1 : 0)
})
