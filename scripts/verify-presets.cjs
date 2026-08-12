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

  // Hand-editing means the brush is no longer that preset.
  R.activeAfterApply = ed.activePresetId === 'paint'
  ed.setBrush({ size: 41 })
  R.editClearsActive = ed.activePresetId === null

  // Every preview must be a real image, and they must not all be the same one.
  const imgs = [...document.querySelectorAll('.preset-strip')]
  R.everyPresetHasAStrip = imgs.length === ed.presets.length
  R.noBlankPreviews = imgs.every((i) => i.naturalWidth > 0 && i.src.startsWith('data:image/png'))
  R.previewsDiffer = new Set(imgs.map((i) => i.src)).size === imgs.length

  R.failed = Object.entries(R).some(([k, v]) => k !== 'failed' && v !== true)
  return R
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
