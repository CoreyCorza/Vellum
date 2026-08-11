const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bench', {
  info: () => ipcRenderer.invoke('bench:info'),
  onPackets: (cb) => ipcRenderer.on('bench:packets', (_e, payload) => cb(payload))
})
