/**
 * WebGL2 stroke renderer — the dab compositor.
 *
 * This runs Krita's dab blend directly, per pixel:
 *
 *     fullFlowAlpha = opacity > dstAlpha ? lerp(dstAlpha, opacity, mskAlpha) : dstAlpha
 *     result        = lerp(dstAlpha, fullFlowAlpha, flow)
 *
 * (KoCompositeOpAlphaDarken, with the Creamy parameter wrapper, whose
 * zero-flow alpha is dstAlpha.)
 *
 * Two properties come out of that and cannot be reproduced any other way:
 *
 *   · it CONVERGES toward the ceiling at a rate set by the dab's profile, so a
 *     soft edge stays soft no matter how many times a stroke crosses it, and
 *   · it NEVER DECREASES, so a later, lighter pass cannot erase a darker one.
 *
 * The formula needs the destination pixel, which means read-modify-write. Fixed
 * function blending — Canvas 2D's recipe menu, and equally WebGL2's blend
 * equations — cannot do it. Every algebraic rearrangement that fits a blend
 * equation (product, min, solving for convergence, footprint-vs-profile) agrees
 * with the real formula in some places and disagrees in others, which is what
 * put a different artifact at the self-intersections each time.
 *
 * So each dab is TWO small draws over its own bounding box:
 *   1. copy that box from the live texture into a scratch, and
 *   2. render the box back into the live texture, sampling the scratch.
 * A fragment shader cannot read the target it writes; this is the standard way
 * around that. Blending is off — the shader computes the final value itself.
 */

const TIP_RESOLUTION = 128

/** Both draws use the same geometry: the dab's bounding box. */
const VERT_DAB = `#version 300 es
in vec2 aUnit;
uniform vec2 uCentre;
uniform float uRadius;
uniform vec2 uView;
out vec2 vTip;
out vec2 vPrev;
void main() {
  vTip = aUnit;
  vec2 px = uCentre + (aUnit - 0.5) * (uRadius * 2.0);
  // Y is flipped on write, so sampling the same document point needs 1 - y.
  vPrev = vec2(px.x / uView.x, 1.0 - px.y / uView.y);
  vec2 clip = (px / uView) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vTip;
in vec2 vPrev;
uniform sampler2D uSrc;
out vec4 oCol;
void main() {
  oCol = texture(uSrc, vPrev);
}`

const FRAG_DAB = `#version 300 es
precision highp float;
in vec2 vTip;
in vec2 vPrev;
uniform sampler2D uTip;
uniform sampler2D uPrev;
uniform float uFlow;
uniform float uCeiling;
out vec4 oCol;
void main() {
  float mskAlpha = texture(uTip, vTip).a;
  float dstAlpha = texture(uPrev, vPrev).a;

  // Krita, verbatim. The comparison is the whole point: without it a lighter
  // dab drags a darker one back down, and the convergence is what keeps a soft
  // edge soft where a stroke overlaps itself.
  float fullFlowAlpha = uCeiling > dstAlpha
    ? mix(dstAlpha, uCeiling, mskAlpha)
    : dstAlpha;

  float a = mix(dstAlpha, fullFlowAlpha, uFlow);
  oCol = vec4(0.0, 0.0, 0.0, a);
}`

const VERT_RESOLVE = `#version 300 es
in vec2 aUnit;
out vec2 vUv;
void main() {
  vUv = aUnit;
  gl_Position = vec4(aUnit * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG_RESOLVE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAccum;
uniform vec3 uColour;
out vec4 oCol;
void main() {
  float a = texture(uAccum, vUv).a;
  // premultiplied, to match the canvas this is drawn into
  oCol = vec4(uColour * a, a);
}`

export interface DabTarget {
  stampDab(
    x: number,
    y: number,
    radius: number,
    flow: number,
    ceiling: number,
    hardness: number
  ): void
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)
  if (!s) throw new Error('createShader failed')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(s)}`)
  }
  return s
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()
  if (!p) throw new Error('createProgram failed')
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`)
  }
  return p
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
}

export class GLStrokeRenderer implements DabTarget {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext

  private dabProg: WebGLProgram
  private copyProg: WebGLProgram
  private resolveProg: WebGLProgram
  private quad: WebGLBuffer

  /** `live` is authoritative; `scratch` holds the pre-dab copy of one box. */
  private live: Target
  private scratch: Target
  private isFloat = false

  private tips = new Map<number, WebGLTexture>()

  private u: Record<string, Record<string, WebGLUniformLocation | null>> = {}

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true
    })
    if (!gl) throw new Error('WebGL2 is required for the stroke renderer.')
    this.gl = gl

    // Half-float removes the 8-bit quantisation stall: at low flow each dab
    // moves alpha by less than 1/255 once it nears the ceiling, and those
    // increments vanish. Safe to request because we never blend into it — the
    // shader writes the final value, so EXT_float_blend is not involved.
    this.isFloat = Boolean(gl.getExtension('EXT_color_buffer_float'))

    this.dabProg = link(gl, VERT_DAB, FRAG_DAB)
    this.copyProg = link(gl, VERT_DAB, FRAG_COPY)
    this.resolveProg = link(gl, VERT_RESOLVE, FRAG_RESOLVE)

    const quad = gl.createBuffer()
    if (!quad) throw new Error('createBuffer failed')
    this.quad = quad
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

    const names = ['uCentre', 'uRadius', 'uView', 'uTip', 'uPrev', 'uSrc', 'uFlow', 'uCeiling', 'uAccum', 'uColour']
    for (const [key, prog] of [
      ['dab', this.dabProg],
      ['copy', this.copyProg],
      ['resolve', this.resolveProg]
    ] as const) {
      this.u[key] = {}
      for (const n of names) this.u[key][n] = gl.getUniformLocation(prog, n)
    }

    this.live = this.makeTarget()
    this.scratch = this.makeTarget()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private makeTarget(): Target {
    const gl = this.gl
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) throw new Error('createTexture/Framebuffer failed')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (this.isFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.HALF_FLOAT, null)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    // NEAREST: the copy and the dab read the exact same texel they write, so any
    // filtering here would smear the destination value the formula depends on.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      if (this.isFloat) {
        // fall back to 8-bit rather than fail outright
        this.isFloat = false
        gl.deleteTexture(tex)
        gl.deleteFramebuffer(fbo)
        return this.makeTarget()
      }
      throw new Error('stroke framebuffer incomplete')
    }
    return { tex, fbo }
  }

  private tipTexture(hardness: number): WebGLTexture {
    const gl = this.gl
    const key = Math.round(Math.max(0, Math.min(1, hardness)) * 200)
    const existing = this.tips.get(key)
    if (existing) return existing

    const h = Math.min(key / 200, 0.985)
    const S = TIP_RESOLUTION
    const data = new Uint8Array(S * S * 4)
    const r = S / 2
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - r + 0.5, y - r + 0.5) / r
        let a: number
        if (d >= 1) a = 0
        else if (d <= h) a = 1
        else {
          const u = (d - h) / (1 - h)
          a = 1 - u * u * (3 - 2 * u)
        }
        const i = (y * S + x) * 4
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        data[i + 3] = Math.round(a * 255)
      }
    }
    const tex = gl.createTexture()
    if (!tex) throw new Error('createTexture failed')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (this.tips.size > 24) {
      const oldest = this.tips.keys().next().value
      if (oldest !== undefined) {
        const t = this.tips.get(oldest)
        if (t) gl.deleteTexture(t)
        this.tips.delete(oldest)
      }
    }
    this.tips.set(key, tex)
    return tex
  }

  private bindQuad(prog: WebGLProgram): void {
    const gl = this.gl
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    const loc = gl.getAttribLocation(prog, 'aUnit')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  }

  beginStroke(): void {
    const gl = this.gl
    // Blending stays off for the whole stroke — the dab shader produces the
    // final value, it does not contribute one to be blended.
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, this.width, this.height)
    for (const t of [this.live, this.scratch]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  stampDab(
    x: number,
    y: number,
    radius: number,
    flow: number,
    ceiling: number,
    hardness: number
  ): void {
    if (flow <= 0 || ceiling <= 0 || radius <= 0) return
    const gl = this.gl

    // 1. copy this dab's box out of the live texture
    this.bindQuad(this.copyProg)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratch.fbo)
    gl.uniform2f(this.u.copy.uView!, this.width, this.height)
    gl.uniform2f(this.u.copy.uCentre!, x, y)
    gl.uniform1f(this.u.copy.uRadius!, radius)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.live.tex)
    gl.uniform1i(this.u.copy.uSrc!, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // 2. render the box back into the live texture, reading the copy
    this.bindQuad(this.dabProg)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.live.fbo)
    gl.uniform2f(this.u.dab.uView!, this.width, this.height)
    gl.uniform2f(this.u.dab.uCentre!, x, y)
    gl.uniform1f(this.u.dab.uRadius!, radius)
    gl.uniform1f(this.u.dab.uFlow!, Math.min(1, flow))
    gl.uniform1f(this.u.dab.uCeiling!, Math.min(1, ceiling))
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tipTexture(hardness))
    gl.uniform1i(this.u.dab.uTip!, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.scratch.tex)
    gl.uniform1i(this.u.dab.uPrev!, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Renders the stroke into the visible canvas, tinted, ready to be blitted
   *  into a Canvas 2D layer. */
  resolve(colourHex: string): void {
    const gl = this.gl
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colourHex)
    const r = m ? parseInt(m[1], 16) / 255 : 0
    const g = m ? parseInt(m[2], 16) / 255 : 0
    const b = m ? parseInt(m[3], 16) / 255 : 0

    this.bindQuad(this.resolveProg)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.live.tex)
    gl.uniform1i(this.u.resolve.uAccum!, 0)
    gl.uniform3f(this.u.resolve.uColour!, r, g, b)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Diagnostics: stroke alpha at a document pixel, 0..255. */
  debugSampleAccum(x: number, y: number): { r: number; g: number; b: number; a: number } {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.live.fbo)
    const row = this.height - 1 - y
    if (this.isFloat) {
      const px = new Float32Array(4)
      gl.readPixels(x, row, 1, 1, gl.RGBA, gl.FLOAT, px)
      const s = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255)
      return { r: s(px[0]), g: s(px[1]), b: s(px[2]), a: s(px[3]) }
    }
    const px = new Uint8Array(4)
    gl.readPixels(x, row, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return { r: px[0], g: px[1], b: px[2], a: px[3] }
  }
}
