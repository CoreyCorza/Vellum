/**
 * The preset shelf.
 *
 * The failure worth guarding against is a silent one: previews are rendered by
 * the real brush engine into an offscreen WebGL surface, so a mistake there
 * produces blank or identical thumbnails rather than an error, and the panel
 * still looks populated.
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

  R.hasBrushesAndErasers =
    ed.presets.some((p) => !p.erase) && ed.presets.filter((p) => p.erase).length >= 2

  // Choosing an eraser preset has to put you in erase mode; picking "Eraser hard"
  // and still painting would be absurd.
  ed.applyPreset('eraser-hard')
  R.eraserPresetErases = ed.tool === 'eraser' && ed.brush.hardness === 1 && ed.brush.size === 34
  ed.applyPreset('ink')
  R.brushPresetPaints = ed.tool === 'brush' && ed.brush.size === 8

  // Colour is global, so loading a preset must not change what you paint with.
  ed.setBrush({ color: '#ff0000' })
  ed.applyPreset('paint')
  R.presetKeepsColour = ed.brush.color === '#ff0000'

  R.activeAfterApply = ed.activePresetId === 'paint'

  // Every preview must be a real image, and they must not all be the same one.
  // Counted across BOTH views: which one is showing is a saved preference, and a
  // test that depends on it fails for reasons that have nothing to do with the code.
  const imgs = [...document.querySelectorAll('.preset-strip, .preset-tile img')]
  R.everyPresetHasAStrip = imgs.length === ed.presets.length
  R.noBlankPreviews = imgs.every((i) => i.naturalWidth > 0 && i.src.startsWith('data:image/png'))
  R.previewsDiffer = new Set(imgs.map((i) => i.src)).size === imgs.length

  // --- the shelf's own actions ---------------------------------------------
  const before = ed.presets.length

  // New from current settings must capture the current TOOL too, so setting up an
  // eraser and pressing the button gives you an eraser preset.
  ed.applyPreset('eraser-soft')
  ed.setBrush({ size: 123 })
  const madeId = ed.addPreset(true)
  const made = ed.presets.find((p) => p.id === madeId)
  R.addedFromCurrent = !!made && made.erase === true && Math.round(made.settings.size) === 123
  R.addedGoesOnShelf = ed.presets.length === before + 1
  R.addedIsSelected = ed.activePresetId === madeId

  // A plain new brush is a default, not a copy.
  const plainId = ed.addPreset(false)
  const plain = ed.presets.find((p) => p.id === plainId)
  R.plainAddIsDefault = !!plain && plain.erase === false && Math.round(plain.settings.size) !== 123

  ed.renamePreset(plainId, '  Scratch  ')
  R.renameTrims = ed.presets.find((p) => p.id === plainId).name === 'Scratch'
  ed.renamePreset(plainId, '   ')
  R.renameRejectsBlank = ed.presets.find((p) => p.id === plainId).name === 'Scratch'

  // Overwrite takes the current settings onto the selected preset.
  ed.applyPreset(plainId)
  ed.setBrush({ size: 77 })
  ed.updatePresetFromBrush(plainId)
  R.overwriteTakesSettings =
    Math.round(ed.presets.find((p) => p.id === plainId).settings.size) === 77

  ed.deletePreset(plainId)
  ed.deletePreset(madeId)
  R.deleteRemoves = ed.presets.length === before && !ed.presets.some((p) => p.id === plainId)
  R.deleteClearsActive = ed.activePresetId === null

  // --- editing a selected brush ---------------------------------------------
  // Editing used to clear the selection, so the settings panel looked like it was
  // editing nothing, and clicking the brush again to get the highlight back
  // reloaded it and threw the edits away.
  ed.applyPreset('ink')
  ed.setBrush({ size: 31 })
  R.editKeepsSelection = ed.activePresetId === 'ink'
  R.editMarksModified = ed.presetModified === true

  // Colour is global, so it is not an edit to the brush.
  ed.applyPreset('ink')
  ed.setBrush({ color: '#00ff00' })
  R.colourIsNotAnEdit = ed.presetModified === false

  // Clicking the row you are already on must not reload it. This goes through the
  // DOM, because the guard lives in the panel rather than the engine — and it has
  // to wait a frame first: React batches, so aria-pressed is still the previous
  // value in the tick that changed the engine.
  ed.applyPreset('ink')
  ed.setBrush({ size: 44 })
  return new Promise((res) => setTimeout(() => {
    const el =
      [...document.querySelectorAll('.preset-row, .preset-tile')].find(
        (n) => n.getAttribute('aria-pressed') === 'true'
      ) || null
    R.foundSelectedInDom = el !== null
    if (el) el.click()
    R.clickingSelectedKeepsEdits = Math.round(ed.brush.size) === 44

    // Revert is the one thing that reloads it.
    ed.revertPreset()
    R.revertRestores = Math.round(ed.brush.size) === 8 && ed.presetModified === false

    R.failed = Object.entries(R).some(([k, v]) => k !== 'failed' && v !== true)
    res(R)
  }, 260))
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1300, height: 900, show: true,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 2000))
  const R = await win.webContents.executeJavaScript(SCRIPT)
  process.stdout.write('PRESETS ' + JSON.stringify(R, null, 2) + '\n')
  app.exit(R.failed ? 1 : 0)
})
