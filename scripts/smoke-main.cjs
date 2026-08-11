const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const root = path.join(__dirname, '..')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(root, 'out/preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })

  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  await new Promise((r) => setTimeout(r, 1500))

  const result = await win.webContents.executeJavaScript(`(() => {
    const root = document.getElementById('root');
    const stage = document.getElementById('view');
    const sliders = document.querySelectorAll('.sl-track');
    const layers = document.querySelectorAll('.layer');
    const touchActions = [...sliders].map(e => getComputedStyle(e).touchAction)
      .filter((v,i,a) => a.indexOf(v) === i);
    return {
      preloadBridge: Boolean(window.vellum && window.vellum.isElectron),
      reactMounted: Boolean(root && root.childElementCount > 0),
      canvasPresent: Boolean(stage),
      canvasSized: stage ? stage.width > 0 && stage.height > 0 : false,
      canvasTouchAction: stage ? getComputedStyle(stage).touchAction : null,
      sliderCount: sliders.length,
      sliderTouchActions: touchActions,
      layerRows: layers.length,
      statusBar: Boolean(document.getElementById('status')),
      rail: document.querySelectorAll('#rail .tool').length
    };
  })()`)

  result.consoleErrors = errors
  result.failed =
    !result.preloadBridge ||
    !result.reactMounted ||
    !result.canvasSized ||
    result.canvasTouchAction !== 'none' ||
    result.sliderCount === 0 ||
    result.sliderTouchActions.join() !== 'none' ||
    result.layerRows === 0 ||
    errors.length > 0

  console.log('SMOKE_RESULT ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
