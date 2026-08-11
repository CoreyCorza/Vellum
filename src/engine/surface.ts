import type { Rect } from './types'
import { rectIsEmpty } from './bounds'

/**
 * A block of pixels.
 *
 * This is the ONLY place in the engine that touches a raw canvas. Everything
 * else — layers, compositor, history, brush — goes through this interface. That
 * containment is what makes the two big planned migrations survivable:
 *
 *   · tiled storage  → Surface grows an internal tile grid; callers unchanged.
 *   · WebGPU         → a GpuSurface implements the same shape; callers unchanged.
 *
 * Keep it that way. If you find yourself reaching for `.ctx` outside the engine,
 * add a method here instead.
 */
/** Anything with a canvas can be a source — a Surface, or the WebGL2 stroke
 *  renderer, whose canvas already holds its resolved output. */
export interface DrawSource {
  readonly canvas: HTMLCanvasElement
}

export class Surface {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  width: number
  height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Surface: could not acquire a 2D context')
    // NOTE: deliberately NOT willReadFrequently. That flag forces a software
    // backing store, which is a large net loss — we blit constantly and read
    // back only once per stroke.
    this.ctx = ctx
    this.ctx.imageSmoothingQuality = 'high'
  }

  clear(r?: Rect): void {
    if (r) {
      if (rectIsEmpty(r)) return
      this.ctx.clearRect(r.x, r.y, r.w, r.h)
    } else {
      this.ctx.clearRect(0, 0, this.width, this.height)
    }
  }

  fill(style: string, r?: Rect): void {
    const c = this.ctx
    c.save()
    c.globalCompositeOperation = 'copy'
    c.fillStyle = style
    if (r) c.fillRect(r.x, r.y, r.w, r.h)
    else c.fillRect(0, 0, this.width, this.height)
    c.restore()
  }

  /** Replace our contents with another surface's. GPU-side; no pixel readback. */
  copyFrom(src: DrawSource, r?: Rect): void {
    const c = this.ctx
    c.save()
    c.globalCompositeOperation = 'copy'
    if (r) {
      if (!rectIsEmpty(r)) c.drawImage(src.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
    } else {
      c.drawImage(src.canvas, 0, 0)
    }
    c.restore()
  }

  /** Draw another surface over this one. */
  draw(
    src: DrawSource,
    opacity = 1,
    op: GlobalCompositeOperation = 'source-over',
    r?: Rect
  ): void {
    if (opacity <= 0) return
    const c = this.ctx
    c.save()
    c.globalAlpha = opacity
    c.globalCompositeOperation = op
    if (r) {
      if (!rectIsEmpty(r)) c.drawImage(src.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
    } else {
      c.drawImage(src.canvas, 0, 0)
    }
    c.restore()
  }

  /**
   * Crop a region into a new Surface, GPU-side.
   *
   * Deliberately NOT getImageData. A readback forces a pipeline sync, which
   * measured at ~17 ms here — a dropped frame on every pen-up, which is exactly
   * where you notice one. Canvas-to-canvas stays on the GPU and costs well
   * under a millisecond, so undo capture is now effectively free.
   */
  extract(r: Rect): Surface {
    const w = Math.max(1, r.w)
    const h = Math.max(1, r.h)
    const out = new Surface(w, h)
    out.ctx.drawImage(this.canvas, r.x, r.y, w, h, 0, 0, w, h)
    return out
  }

  /** Exact replacement of a region — clear first, so this overwrites rather
   *  than blends. Used to put an undo patch back. */
  restore(patch: Surface, x: number, y: number): void {
    const c = this.ctx
    c.save()
    c.globalCompositeOperation = 'source-over'
    c.clearRect(x, y, patch.width, patch.height)
    c.drawImage(patch.canvas, x, y)
    c.restore()
  }

  getPatch(r: Rect): ImageData {
    return this.ctx.getImageData(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h))
  }

  putPatch(data: ImageData, x: number, y: number): void {
    this.ctx.putImageData(data, x, y)
  }

  /** Single-pixel read, for the eyedropper. */
  sample(x: number, y: number): [number, number, number, number] {
    const d = this.ctx.getImageData(x, y, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }

  toBlob(type = 'image/png'): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Surface.toBlob produced nothing'))),
        type
      )
    })
  }
}
