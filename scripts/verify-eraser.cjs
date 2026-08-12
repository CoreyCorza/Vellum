/**
 * The eraser's inheritance rules, stated as behaviour.
 *
 * The design: every eraser value follows the brush until it is touched, then that
 * one value stops following. It serves both expectations without a preference —
 * a Krita user never changes an eraser setting and so never leaves the coupled
 * behaviour, while a Photoshop user hardens the eraser once and has an
 * independent eraser from then on.
 *
 * These are the rules that make that true, and each is easy to break by accident
 * while editing the panel or the settings plumbing.
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
  ed.setTool('brush')
  ed.relinkEraser()
  ed.setBrush({ size: 40, hardness: 0.2, color: '#123456' })

  // 1. Untouched, the eraser IS the brush. The Krita expectation.
  ed.setTool('eraser')
  R.inheritsAll = ed.brush.size === 40 && ed.brush.hardness === 0.2
  R.startsClean = ed.eraserOverrideCount === 0

  // 2. Touching one value decouples ONLY that value.
  ed.setBrush({ hardness: 1 })
  R.overrideTook = ed.brush.hardness === 1
  R.overrideIsScoped = ed.eraserOverrideCount === 1 &&
    ed.eraserFollows('size') === true && ed.eraserFollows('hardness') === false

  // 3. The brush itself is untouched by anything done in eraser mode. This is
  //    the property that makes the coupled camp safe: E can never damage a brush.
  ed.setTool('brush')
  R.brushUnharmed = ed.brush.hardness === 0.2 && ed.brush.size === 40

  // 4. Inherited values keep tracking the brush after the fact; overridden ones
  //    do not. The useful case neither Photoshop nor Krita can express.
  ed.setBrush({ size: 90, hardness: 0.05 })
  ed.setTool('eraser')
  R.sizeStillFollows = ed.brush.size === 90
  R.hardnessStaysOwn = ed.brush.hardness === 1

  // 5. Colour is shared. An eraser has no colour, so choosing one while it is
  //    selected must set what you paint with next, not vanish into the eraser.
  ed.setBrush({ color: '#abcdef' })
  ed.setTool('brush')
  R.colourIsShared = ed.brush.color === '#abcdef' && ed.eraserFollows('color') === true

  // 6. Flipping the pen over erases without changing the selected tool, so it
  //    must still use the eraser's settings rather than the brush's.
  R.invertedPenUsesEraser =
    ed.settingsFor(true).hardness === 1 && ed.settingsFor(false).hardness === 0.05

  // 7. Relinking returns to following, and does not disturb the brush.
  ed.setTool('eraser')
  ed.relinkEraser('hardness')
  R.relinkFollowsAgain = ed.brush.hardness === 0.05 && ed.eraserOverrideCount === 0
  ed.setTool('brush')
  R.relinkLeftBrushAlone = ed.brush.hardness === 0.05

  // 8. A preset is a statement about the BRUSH, whichever tool is selected.
  //    Routing it through the eraser wrote the whole preset into overrides: the
  //    brush never changed and every setting stopped following in one click.
  ed.setTool('brush')
  ed.relinkEraser()
  ed.setBrush({ size: 40, hardness: 0.2 })
  ed.setTool('eraser')
  ed.setBrush({ hardness: 1 })            // the eraser owns hardness now
  ed.applyBrushPreset({ size: 8, hardness: 0.92, flow: 1 })

  ed.setTool('brush')
  R.presetReachesBrush = ed.brush.size === 8 && ed.brush.hardness === 0.92
  ed.setTool('eraser')
  R.presetCreatesNoOverrides = ed.eraserOverrideCount === 1
  R.presetFlowsToInherited = ed.brush.size === 8 && ed.brush.flow === 1
  R.presetLeavesOwnedAlone = ed.brush.hardness === 1

  // --- spring-loaded E ------------------------------------------------------
  // Tap to switch, hold-and-erase to borrow. Which was meant is only knowable on
  // release, and the test is whether the eraser was USED while the key was down.
  const key = (type, opts) =>
    window.dispatchEvent(new KeyboardEvent(type, { key: 'e', bubbles: true, ...opts }))
  const drawSomething = () => {
    const pt = (x) => ({ x: x, y: 500, pressure: 1, tilt: 0, twist: 0, t: x * 16 })
    ed.beginStroke(pt(100), true)
    ed.extendStroke(pt(140))
    ed.endStroke()
  }

  ed.setTool('brush')

  // 9. Tap from the brush: switch and stay.
  key('keydown'); key('keyup')
  R.tapSwitches = ed.tool === 'eraser'

  // 10. Tap again: the other half of the toggle.
  key('keydown'); key('keyup')
  R.tapAgainToggles = ed.tool === 'brush'

  // 11. Hold, erase, release: back to what was in hand.
  key('keydown')
  R.holdActivates = ed.tool === 'eraser'
  drawSomething()
  key('keyup')
  R.holdSpringsBack = ed.tool === 'brush'

  // 12. Auto-repeat must not re-arm, or the remembered tool becomes 'eraser' one
  //     tick in and there is nothing to spring back to.
  key('keydown')
  key('keydown', { repeat: true })
  key('keydown', { repeat: true })
  drawSomething()
  key('keyup')
  R.repeatDoesNotBreakSpring = ed.tool === 'brush'

  // 13. Holding without erasing is a slow tap, not a borrow.
  key('keydown')
  key('keyup')
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
