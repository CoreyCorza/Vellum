/**
 * How expensive is the luminanceToAlpha mask?
 *
 * It runs every frame during a stroke, so if the SVG filter leaves the GPU path
 * it will dominate everything. Times it over a full surface and over a typical
 * stroke rect, against a plain destination-in for reference.
 */
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: true })
  await win.loadURL('data:text/html,<body></body>')

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0')
    svg.innerHTML = '<filter id="l2a" x="0%" y="0%" width="100%" height="100%" ' +
      'color-interpolation-filters="sRGB"><feColorMatrix type="luminanceToAlpha"/></filter>'
    document.body.appendChild(svg)

    const W = 2048, H = 1400
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c }
    const a = mk(), b = mk()
    const ac = a.getContext('2d'), bc = b.getContext('2d')
    ac.fillStyle = 'rgba(0,0,0,0.5)'; ac.fillRect(0, 0, W, H)
    bc.fillStyle = 'rgb(128,128,128)'; bc.fillRect(0, 0, W, H)

    const time = (label, fn, iters) => {
      fn() // warm
      const t0 = performance.now()
      for (let i = 0; i < iters; i++) fn()
      // force completion
      ac.getImageData(0, 0, 1, 1)
      return { label, msPerCall: +((performance.now() - t0) / iters).toFixed(2) }
    }

    const filteredFull = () => {
      ac.save(); ac.filter = 'url(#l2a)'; ac.globalCompositeOperation = 'destination-in'
      ac.drawImage(b, 0, 0); ac.restore()
    }
    const filteredRect = () => {
      ac.save(); ac.filter = 'url(#l2a)'; ac.globalCompositeOperation = 'destination-in'
      ac.drawImage(b, 400, 400, 600, 300, 400, 400, 600, 300); ac.restore()
    }
    const plainFull = () => {
      ac.save(); ac.globalCompositeOperation = 'destination-in'
      ac.drawImage(b, 0, 0); ac.restore()
    }

    return {
      rows: [
        time('filtered full 2048x1400', filteredFull, 10),
        time('filtered 600x300 rect', filteredRect, 20),
        time('plain destination-in full', plainFull, 20)
      ]
    }
  })()`)

  console.log('MASKCOST ' + JSON.stringify(result, null, 2))
  app.exit(0)
})
