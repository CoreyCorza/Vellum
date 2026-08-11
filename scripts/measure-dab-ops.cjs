/**
 * Per-dab cost of each drawing primitive on a document-sized canvas.
 *
 * A stroke is ~1000 dabs, so anything above ~0.05ms per dab is unaffordable.
 * Blend modes other than source-over are the suspects — they can drop Skia off
 * its fast path.
 */
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: true })
  await win.loadURL('data:text/html,<body></body>')

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const W = 2048, H = 1400
    const big = document.createElement('canvas'); big.width = W; big.height = H
    const g = big.getContext('2d')
    const sprite = document.createElement('canvas'); sprite.width = 128; sprite.height = 128
    const sc = sprite.getContext('2d')
    sc.fillStyle = 'rgb(128,128,128)'; sc.fillRect(0, 0, 128, 128)

    const N = 600
    const time = (label, setup, fn) => {
      setup()
      fn(0) // warm
      const t0 = performance.now()
      for (let i = 0; i < N; i++) fn(i)
      g.getImageData(0, 0, 1, 1) // force completion
      return { label, msPerDab: +((performance.now() - t0) / N).toFixed(4) }
    }

    const pos = (i) => ({ x: 200 + (i % 400) * 4, y: 300 + ((i * 7) % 400) })

    const rows = [
      time('drawImage source-over', () => {
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.5
      }, (i) => { const p = pos(i); g.drawImage(sprite, p.x, p.y, 120, 120) }),

      time('drawImage lighten', () => {
        g.globalCompositeOperation = 'lighten'; g.globalAlpha = 1
      }, (i) => { const p = pos(i); g.drawImage(sprite, p.x, p.y, 120, 120) }),

      time('arc+fill source-over', () => {
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.5
        g.fillStyle = '#000000'
      }, (i) => {
        const p = pos(i); g.beginPath(); g.arc(p.x, p.y, 60, 0, 6.2832); g.fill()
      }),

      time('drawImage lighten + save/restore', () => {}, (i) => {
        const p = pos(i)
        g.save(); g.globalCompositeOperation = 'lighten'; g.globalAlpha = 1
        g.drawImage(sprite, p.x, p.y, 120, 120); g.restore()
      })
    ]
    return { rows }
  })()`)

  console.log('DABOPS ' + JSON.stringify(result, null, 2))
  app.exit(0)
})
