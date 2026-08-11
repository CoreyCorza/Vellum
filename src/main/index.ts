import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { suppressPenFeedback } from './penFeedback'
import { WintabService, registerWintabIpc } from './wintabService'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141517',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // .mjs, not .js — package.json is `"type": "module"`, so electron-vite
      // emits an ESM preload. Pointing at .js here fails silently: the bridge
      // never loads, `window.inkwell` is undefined, and the app quietly
      // downgrades to browser fallbacks instead of erroring.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Chromium creates its render-widget child HWND lazily, and that is the
  // window the tablet service actually looks the property up on. Re-apply at
  // each stage so we cannot miss it. Logged rather than thrown — the app is
  // perfectly usable with the OS rings, just uglier.
  const applyPen = (when: string): void => {
    console.log(`[pen] ${when}:`, JSON.stringify(suppressPenFeedback(win)))
  }
  applyPen('on-create')
  win.once('ready-to-show', () => {
    applyPen('ready-to-show')
    win.show()
  })
  win.webContents.once('did-finish-load', () => applyPen('did-finish-load'))

  // Wintab: the real pen path on Windows. Falls back silently to Pointer
  // Events if no tablet driver exposes it.
  const wintab = new WintabService(win)
  registerWintabIpc(wintab)
  const status = wintab.start()
  console.log('[wintab]', JSON.stringify(status))
  win.on('closed', () => wintab.dispose())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Removing the application menu also removes Electron's built-in DevTools
  // accelerator. Keep the menu hidden, but preserve the usual inspection
  // shortcuts for UI and CSS work.
  win.webContents.on('before-input-event', (event, input) => {
    const toggleDevTools =
      input.key === 'F12' ||
      ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')

    if (toggleDevTools) {
      event.preventDefault()
      win.webContents.toggleDevTools()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * No application menu.
 *
 * Every shortcut lives in the renderer, so there is exactly one code path and
 * the app behaves identically under `npm run dev` and `npm run dev:web`. A menu
 * with accelerators would double-fire against the renderer's own handlers —
 * press Ctrl+Z once, undo twice. A custom title bar is the eventual answer;
 * see ROADMAP.
 */
Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  ipcMain.handle(
    'file:savePng',
    async (_e, bytes: Uint8Array, defaultName: string): Promise<string | null> => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export PNG',
        defaultPath: defaultName,
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      })
      if (canceled || !filePath) return null
      await writeFile(filePath, Buffer.from(bytes))
      return filePath
    }
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
