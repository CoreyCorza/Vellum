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

/** Both draws use the same geometry: the dab's bounding box. */
const VERT_DAB = `#version 300 es
in vec2 aUnit;
uniform vec2 uCentre;
uniform float uRadius;
uniform vec2 uView;
out vec2 vOffset;
out vec2 vPrev;
void main() {
  // A pixel of padding around the dab, for two reasons. A sub-pixel dab drawn
  // at exactly its own diameter can fall entirely between pixel centres and
  // rasterise to no fragments at all — that is what made a 1px brush draw a
  // dashed line. And at any size, the outermost half pixel of the antialiased
  // rim falls outside a quad that stops at the radius, so it was being clipped.
  float ext = uRadius + 1.0;
  vOffset = (aUnit - 0.5) * (ext * 2.0);
  vec2 px = uCentre + vOffset;
  // Y is flipped on write, so sampling the same document point needs 1 - y.
  vPrev = vec2(px.x / uView.x, 1.0 - px.y / uView.y);
  vec2 clip = (px / uView) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vPrev;
uniform sampler2D uSrc;
out vec4 oCol;
void main() {
  oCol = texture(uSrc, vPrev);
}`

const FRAG_DAB = `#version 300 es
precision highp float;
// Width of the antialiasing band at a dab's rim, in document pixels. Wider than
// one pixel deliberately — see the note in main().
#define AA_PX 1.5

in vec2 vOffset;
in vec2 vPrev;
uniform sampler2D uPrev;
uniform float uFlow;
uniform float uCeiling;
uniform float uHardness;
uniform float uRadius;
out vec4 oCol;
void main() {
  // The falloff is evaluated here rather than sampled from a sprite. A sprite
  // has one fixed resolution, so a brush wider than it got a magnified rim
  // (visibly faceted) and a narrower one got it minified — and 8-bit sprite
  // alpha banded the ramp on top of that.
  //
  // Everything below is in document pixels, not fractions of the radius, which
  // is the only way one expression can serve a 1px brush and a 500px brush.
  float dPx = length(vOffset);

  // The rim sits half a pixel outside the nominal radius, so the antialiasing
  // band has somewhere to live. For a sub-pixel dab that half pixel is most of
  // the footprint — without it the dab can miss every pixel centre and vanish,
  // which is what made a 1px brush draw a dashed line.
  float rimPx = uRadius + 0.5;

  // Hardness sets where the falloff starts. The ramp never gets narrower than
  // AA_PX, so there is always an antialiasing band at every size and hardness.
  //
  // AA_PX is wider than one pixel on purpose. At exactly 1.0, pixel centres are
  // spaced the full width of the band, so on some edge angles one sample lands
  // at coverage 1 and the next at 0 with nothing in between — a black pixel
  // touching a white one, with no transition.
  // The band is bounded at both ends, and both bounds matter.
  //
  // Too wide and a small hard brush never reaches full coverage anywhere, so a
  // 2px line draws grey: at radius 1, a 1.5px band spans the entire dab. Too
  // narrow and adjacent pixel centres straddle the whole band, which is the
  // solid-touching-empty case. Coverage at the centre is rimPx / band, so a
  // solid core needs band <= 1.5; samples step by 1 / band, so a transition
  // pixel needs band >= ~1.1. 1.25 sits inside that window at radius 1.
  // ...and the floor cannot exceed rimPx either, or a SUB-pixel dab never
  // reaches full coverage even at its own centre and a 1px line draws pale.
  float aaPx = clamp(uRadius, min(1.25, rimPx), AA_PX);
  float innerPx = uHardness * uRadius;
  float rampPx = max(aaPx, rimPx - innerPx);

  // 0 outside the rim, 1 at the inner end of the ramp.
  float x = clamp((rimPx - dPx) / rampPx, 0.0, 1.0);

  // Two different jobs, so two different curves.
  //
  // Where the ramp IS just the antialiasing band, what the value should express
  // is how much of the pixel the shape covers, and for an edge crossing a pixel
  // that is close to LINEAR. Shaping it with smoothstep instead was the other
  // half of the hard-edge problem: smoothstep pushes 0.1 down to 0.03 and 0.9 up
  // to 0.97, so the few intermediate samples that exist get crushed to black and
  // white anyway.
  //
  // Once hardness opens the ramp well past the band, the curve stops being about
  // coverage and becomes the look of a soft brush, where smoothstep's eased
  // shoulders are what is wanted. So blend between them on ramp width.
  float shaped = x * x * (3.0 - 2.0 * x);
  float soft = clamp((rampPx - aaPx) / aaPx, 0.0, 1.0);
  float mskAlpha = mix(x, shaped, soft);
  float dstAlpha = texture(uPrev, vPrev).a;

  // Krita, verbatim. The comparison is the whole point: without it a lighter
  // dab drags a darker one back down, and the convergence is what keeps a soft
  // edge soft where a stroke overlaps itself.
  float fullFlowAlpha = uCeiling > dstAlpha
    ? mix(dstAlpha, uCeiling, mskAlpha)
    : dstAlpha;

  float a = mix(dstAlpha, fullFlowAlpha, uFlow);

  // A dab may not push a pixel past its OWN coverage. Without this the ramp the
  // mask so carefully computes does not survive the stroke: dabs land every half
  // pixel, so a pixel in the antialiasing band is hit by a dozen of them, and
  // 1 - (1 - m)^12 drives even a small m to nearly full. The band collapses to
  // less than a pixel and the edge comes out chewed — which is why widening the
  // band alone fixed nothing.
  //
  // Clamping to the dab's own coverage makes the alpha of a stroke the MAXIMUM
  // over its dabs rather than their sum, so it equals the coverage of the swept
  // shape. That is Krita's "hard" AlphaDarken wrapper as opposed to "creamy".
  //
  // But it only belongs where the ramp IS the antialiasing band. Applied to a
  // soft brush it also stops overlapping passes from building on each other, so
  // the inside of a loop never fills in and a pale seam appears wherever the
  // stroke crosses itself — Krita picks one wrapper per preset for exactly this
  // reason. The soft factor is already 0 when the ramp is just the band and 1
  // once hardness has opened it, so it selects between them.
  float capped = min(a, max(dstAlpha, mskAlpha * uCeiling));
  oCol = vec4(0.0, 0.0, 0.0, mix(capped, a, soft));
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

    const names = ['uCentre', 'uRadius', 'uView', 'uPrev', 'uSrc', 'uFlow', 'uCeiling', 'uHardness', 'uAccum', 'uColour']
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
    gl.uniform1f(this.u.dab.uHardness!, Math.max(0, Math.min(1, hardness)))
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
