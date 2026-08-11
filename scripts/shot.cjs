/**
 * Capture a PNG of the real app window. Optional args:
 *   node scripts/shot.cjs [outfile] [jsToRunFirst]
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

const root = path.join(__dirname, '..')
const outFile = process.argv[2] || path.join(root, 'shot.png')
const preScript = process.argv[3] || ''

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Must be shown: an offscreen window does not reliably composite, and
    // capturePage then returns a stale frame — which silently produced
    // screenshots of the UI as it looked *before* the script interacted.
    show: true,
    backgroundColor: '#131313',
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'), { search: 'debug' })
  await new Promise((r) => setTimeout(r, 1600))
  let scriptResult
  if (preScript) {
    scriptResult = await win.webContents.executeJavaScript(preScript)
    await new Promise((r) => setTimeout(r, 700))
  }
  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SHOT ' + JSON.stringify({ outFile, scriptResult, consoleErrors: errors }))
  app.exit(errors.length ? 1 : 0)
})
