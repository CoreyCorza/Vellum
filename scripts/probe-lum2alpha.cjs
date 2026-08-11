/**
 * Can we turn an opaque grey image into an alpha mask, on the GPU?
 *
 * Canvas 2D has no max-alpha composite op, but `lighten` gives a true per-channel
 * max on COLOUR. So the opacity ceiling can be accumulated as grey, if there is
 * a readback-free way to convert luminance back into alpha. `ctx.filter` with an
 * SVG feColorMatrix type="luminanceToAlpha" should do exactly that.
 */
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false })
  await win.loadURL('data:text/html,<body></body>')

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const out = {}

    // inline the filter
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0')
    svg.innerHTML =
      '<filter id="lum2a" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">' +
      '<feColorMatrix type="luminanceToAlpha"/></filter>'
    document.body.appendChild(svg)

    // a source: opaque grey ramp
    const src = document.createElement('canvas'); src.width = 4; src.height = 1
    const sc = src.getContext('2d')
    const levels = [0, 64, 128, 255]
    for (let i = 0; i < 4; i++) {
      sc.fillStyle = 'rgb(' + levels[i] + ',' + levels[i] + ',' + levels[i] + ')'
      sc.fillRect(i, 0, 1, 1)
    }

    // MAX check: draw a second grey over the first with 'lighten'
    const maxTest = document.createElement('canvas'); maxTest.width = 1; maxTest.height = 1
    const mc = maxTest.getContext('2d')
    mc.fillStyle = 'rgb(200,200,200)'; mc.fillRect(0, 0, 1, 1)
    mc.globalCompositeOperation = 'lighten'
    mc.fillStyle = 'rgb(80,80,80)'; mc.fillRect(0, 0, 1, 1)   // weaker: must not win
    out.lightenKeepsMax = mc.getImageData(0, 0, 1, 1).data[0]

    // now convert luminance -> alpha
    const dst = document.createElement('canvas'); dst.width = 4; dst.height = 1
    const dc = dst.getContext('2d')
    // start fully opaque white so destination-in has something to mask
    dc.fillStyle = '#ffffff'; dc.fillRect(0, 0, 4, 1)
    dc.filter = 'url(#lum2a)'
    dc.globalCompositeOperation = 'destination-in'
    dc.drawImage(src, 0, 0)
    dc.filter = 'none'
    const d = dc.getImageData(0, 0, 4, 1).data
    out.filterSupported = dc.filter !== undefined
    out.alphaOut = [d[3], d[7], d[11], d[15]]
    out.greyIn = levels
    // luminanceToAlpha on a neutral grey yields alpha ~= the grey level
    out.matchesWithin = out.alphaOut.map((a, i) => Math.abs(a - levels[i]))
    out.works = out.matchesWithin.every((v) => v <= 6) && out.lightenKeepsMax === 200
    return out
  })()`)

  console.log('LUM2ALPHA ' + JSON.stringify(result, null, 2))
  app.exit(result.works ? 0 : 1)
})
