/**
 * SPIKE — can WebGL2 express the dab blend a paint engine actually needs?
 *
 * Canvas 2D offers a fixed menu of blend recipes, none containing a conditional,
 * which is why every approximation leaked a different artifact. This tests the
 * real model in one draw per dab:
 *
 *   coverage -> RED channel,  FUNC_ADD with dst factor ONE_MINUS_SRC_COLOR
 *               => R' = cov + R*(1-cov)      i.e. flow accumulation
 *   ceiling  -> ALPHA channel, MAX equation
 *               => A' = max(cap, A)          i.e. opacity as a true ceiling
 *   final    -> min(coverage, ceiling)
 *
 * Nothing in the app is touched. This only answers "does the primitive work".
 */
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 500, height: 400, show: true })
  await win.loadURL('data:text/html,<body></body>')

  const result = await win.webContents.executeJavaScript(String.raw`(() => {
    const W = 900, H = 700
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H
    const gl = cv.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
    if (!gl) return { failed: true, reason: 'no webgl2' }

    const out = {}
    out.webgl2 = true
    out.hasMaxBlendEquation = typeof gl.MAX === 'number'
    out.floatColorBuffer = Boolean(gl.getExtension('EXT_color_buffer_float'))

    // ---- tip profile texture ------------------------------------------------
    const TS = 128
    const makeTip = (hardness) => {
      const data = new Uint8Array(TS * TS * 4)
      const r = TS / 2
      for (let y = 0; y < TS; y++) {
        for (let x = 0; x < TS; x++) {
          const d = Math.hypot(x - r + 0.5, y - r + 0.5) / r
          let a
          if (d >= 1) a = 0
          else if (d <= hardness) a = 1
          else { const u = (d - hardness) / (1 - hardness); a = 1 - u * u * (3 - 2 * u) }
          const i = (y * TS + x) * 4
          data[i] = data[i + 1] = data[i + 2] = 255
          data[i + 3] = Math.round(a * 255)
        }
      }
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TS, TS, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return tex
    }

    // ---- program ------------------------------------------------------------
    const vs = '#version 300 es\n' +
      'in vec2 aUnit;\n' +
      'uniform vec2 uCentre; uniform float uRadius; uniform vec2 uView;\n' +
      'out vec2 vUv;\n' +
      'void main(){\n' +
      '  vUv = aUnit;\n' +
      '  vec2 px = uCentre + (aUnit - 0.5) * (uRadius * 2.0);\n' +
      '  vec2 clip = (px / uView) * 2.0 - 1.0;\n' +
      '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);\n' +
      '}\n'
    const fs = '#version 300 es\n' +
      'precision highp float;\n' +
      'in vec2 vUv;\n' +
      'uniform sampler2D uTip; uniform float uFlow; uniform float uCeiling;\n' +
      'out vec4 oCol;\n' +
      'void main(){\n' +
      '  float p = texture(uTip, vUv).a;\n' +
      '  if (p <= 0.0) discard;\n' +
      '  oCol = vec4(uFlow * p, 0.0, 0.0, uCeiling * p);\n' +
      '}\n'
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
      return s
    }
    const prog = gl.createProgram()
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { failed: true, reason: gl.getProgramInfoLog(prog) }
    gl.useProgram(prog)

    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aUnit')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const U = (n) => gl.getUniformLocation(prog, n)
    gl.uniform2f(U('uView'), W, H)
    gl.uniform1i(U('uTip'), 0)
    gl.activeTexture(gl.TEXTURE0)

    // ---- the blend that Canvas 2D cannot express ---------------------------
    gl.enable(gl.BLEND)
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX)
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE)

    const readAt = (x, y) => {
      const px = new Uint8Array(4)
      gl.readPixels(x, H - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      // final alpha = min(coverage, ceiling)
      return Math.min(px[0], px[3])
    }
    const columnMin = (x, y0, y1) => {
      const h = y1 - y0
      const px = new Uint8Array(4 * h)
      gl.readPixels(x, H - y1, 1, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const vals = []
      for (let i = h - 1; i >= 0; i--) vals.push(Math.min(px[i * 4], px[i * 4 + 3]))
      return vals // top -> bottom
    }

    const stroke = (pts, opts) => {
      gl.bindTexture(gl.TEXTURE_2D, makeTip(opts.hardness))
      gl.uniform1f(U('uFlow'), opts.flow)
      const interval = Math.max(0.6, opts.size * opts.spacing)
      let carry = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i]
        const seg = Math.hypot(b.x - a.x, b.y - a.y)
        let used = 0
        while (carry + (seg - used) >= interval) {
          used += interval - carry
          carry = 0
          const t = used / seg
          const ceiling = opts.opacity * (b.p !== undefined ? (a.p + (b.p - a.p) * t) : 1)
          gl.uniform1f(U('uCeiling'), ceiling)
          gl.uniform2f(U('uCentre'), a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
          gl.uniform1f(U('uRadius'), opts.size / 2)
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        }
        carry += seg - used
      }
    }
    const clear = () => { gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT) }

    // ================= the four reported artifacts =========================
    const line = (x0,y0,x1,y1,n,p0,p1) => {
      const a = []
      for (let i = 0; i <= n; i++) {
        const t = i / n
        a.push({ x: x0+(x1-x0)*t, y: y0+(y1-y0)*t,
                 p: p0 === undefined ? undefined : p0+(p1-p0)*t })
      }
      return a
    }

    // 1. flat opacity across a self-overlapping scribble
    clear()
    const scribble = []
    for (let row = 0; row < 10; row++) {
      const y = 250 + row * 22
      for (let i = 0; i <= 30; i++) {
        const t = row % 2 === 0 ? i/30 : 1 - i/30
        scribble.push({ x: 200 + t * 400, y })
      }
    }
    stroke(scribble, { size: 70, hardness: 0.9, spacing: 0.06, opacity: 0.5, flow: 1 })
    out.scribbleFlat50 = readAt(400, 350)

    // 2. self-intersection: heavy pass then light pass
    clear()
    const cross = line(150, 400, 750, 400, 60).concat(line(450, 150, 450, 650, 50, 0.2, 0.2))
    cross.forEach((q, i) => { if (i <= 60) q.p = 1.0 })
    stroke(cross, { size: 60, hardness: 0.9, spacing: 0.06, opacity: 1, flow: 1 })
    out.crossing = {
      heavyOnly: readAt(250, 400),
      lightOnly: readAt(450, 250),
      atCrossing: readAt(450, 400)
    }

    // 3. soft edge must stay soft where the stroke doubles back
    const rampWidth = (passes) => {
      clear()
      let pts = []
      for (let p = 0; p < passes; p++) {
        pts = pts.concat(p % 2 === 0 ? line(150, 400, 750, 400, 60) : line(750, 400, 150, 400, 60))
      }
      stroke(pts, { size: 120, hardness: 0.05, spacing: 0.05, opacity: 1, flow: 1 })
      const col = columnMin(450, 300, 402)
      let lo = -1, hi = -1
      for (let i = 0; i < col.length; i++) {
        if (lo < 0 && col[i] >= 26) lo = i
        if (col[i] >= 230) { hi = i; break }
      }
      return lo >= 0 && hi >= 0 ? hi - lo : -1
    }
    out.edgeRamp = { singlePass: rampWidth(1), doubleBack: rampWidth(2) }

    // 4. flow still builds up, so it stays a different control
    const flowLevel = (passes) => {
      clear()
      let pts = []
      for (let p = 0; p < passes; p++) {
        pts = pts.concat(p % 2 === 0 ? line(150, 400, 750, 400, 60) : line(750, 400, 150, 400, 60))
      }
      stroke(pts, { size: 60, hardness: 0.9, spacing: 0.06, opacity: 1, flow: 0.06 })
      return readAt(450, 400)
    }
    out.flowBuildUp = { onePass: flowLevel(1), threePasses: flowLevel(3) }

    out.verdict = {
      scribbleIsFlat50: Math.abs(out.scribbleFlat50 - 128) <= 12,
      crossingKeepsHeavy: out.crossing.atCrossing >= out.crossing.heavyOnly - 12,
      edgeStaysSoft: out.edgeRamp.singlePass > 8 &&
                     out.edgeRamp.doubleBack >= out.edgeRamp.singlePass * 0.85,
      flowStillBuilds: out.flowBuildUp.threePasses > out.flowBuildUp.onePass + 20
    }
    out.allPass = Object.values(out.verdict).every(Boolean)
    return out
  })()`)

  console.log('WEBGLSPIKE ' + JSON.stringify(result, null, 2))
  app.exit(result.allPass ? 0 : 1)
})
