/**
 * The eraser as its own preset, plus the E key.
 *
 * The eraser is a second brush: same settings, its own values, nothing shared or
 * derived except colour and symmetry, which are global. E taps to toggle and
 * holds to borrow.
 */
const { app, BrowserWindow, dialog } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

dialog.showErrorBox = (t, c) => { process.stdout.write(`FATAL ${t}: ${c}\n`); app.exit(1) }
process.on('uncaughtException', (e) => { process.stdout.write(`FATAL ${e && e.stack}\n`); app.exit(1) })
setTimeout(() => { process.stdout.write('FATAL watchdog\n'); app.exit(1) }, 90000)

const SCRIPT = `(() => {
  const ed = window.editor
  const R = {}

  // --- two independent presets ---------------------------------------------
  ed.setTool('brush')
  ed.setBrush({ size: 40, hardness: 0.2, color: '#123456' })
  ed.setTool('eraser')
  ed.setBrush({ size: 90, hardness: 1 })

  R.eraserHasOwnValues = ed.brush.size === 90 && ed.brush.hardness === 1
  ed.setTool('brush')
  R.brushUntouched = ed.brush.size === 40 && ed.brush.hardness === 0.2

  // Editing the brush must not reach the eraser.
  ed.setBrush({ size: 12 })
  ed.setTool('eraser')
  R.eraserUnaffectedByBrush = ed.brush.size === 90

  // Colour is global: an eraser cannot show one, so choosing it while erasing has
  // to set what gets painted next.
  ed.setBrush({ color: '#abcdef' })
  ed.setTool('brush')
  R.colourIsGlobal = ed.brush.color === '#abcdef'

  // Flipping the pen erases without changing tools, so it must still use the
  // eraser's preset.
  R.invertedPenUsesEraser =
    ed.settingsFor(true).size === 90 && ed.settingsFor(false).size === 12

  // --- the E key ------------------------------------------------------------
  const key = (type, opts) =>
    window.dispatchEvent(new KeyboardEvent(type, { key: 'e', bubbles: true, ...opts }))
  const draw = () => {
    const pt = (x) => ({ x: x, y: 500, pressure: 1, tilt: 0, twist: 0, t: x * 16 })
    ed.beginStroke(pt(100), true)
    ed.extendStroke(pt(140))
    ed.endStroke()
  }

  ed.setTool('brush')
  key('keydown'); key('keyup')
  R.tapSwitches = ed.tool === 'eraser'

  key('keydown'); key('keyup')
  R.tapAgainToggles = ed.tool === 'brush'

  key('keydown')
  R.holdActivates = ed.tool === 'eraser'
  draw()
  key('keyup')
  R.holdSpringsBack = ed.tool === 'brush'

  // Auto-repeat must not re-arm, or the remembered tool becomes 'eraser' a tick
  // after the key goes down and release has nothing to return to.
  key('keydown'); key('keydown', { repeat: true }); key('keydown', { repeat: true })
  draw()
  key('keyup')
  R.repeatDoesNotBreakSpring = ed.tool === 'brush'

  key('keydown'); key('keyup')
  R.holdWithoutUseStays = ed.tool === 'eraser'
  ed.setTool('brush')

  R.failed = Object.entries(R).some(([k, v]) => k !== 'failed' && v !== true)
  return R
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1500))
  const R = await win.webContents.executeJavaScript(SCRIPT)
  process.stdout.write('ERASER ' + JSON.stringify(R, null, 2) + '\n')
  app.exit(R.failed ? 1 : 0)
})
