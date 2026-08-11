import type { Pt } from './types'
import { clamp } from './types'

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 64

/**
 * A camera over the document.
 *
 * The document is the artwork; this is only where you happen to be looking. The
 * visible canvas never stores pixels — keeping that separation is what makes
 * canvas rotation, multiple views and zoom-independent rendering possible
 * instead of a retrofit.
 */
export class Camera {
  /** Document coordinate currently at the centre of the viewport. */
  cx: number
  cy: number
  scale = 1
  /** radians */
  rotation = 0

  /** Viewport size in CSS pixels. */
  vw = 1
  vh = 1

  constructor(docWidth: number, docHeight: number) {
    this.cx = docWidth / 2
    this.cy = docHeight / 2
  }

  setViewport(w: number, h: number): void {
    this.vw = Math.max(1, w)
    this.vh = Math.max(1, h)
  }

  screenToDoc(sx: number, sy: number): Pt {
    const dx = (sx - this.vw / 2) / this.scale
    const dy = (sy - this.vh / 2) / this.scale
    const c = Math.cos(-this.rotation)
    const s = Math.sin(-this.rotation)
    return { x: this.cx + dx * c - dy * s, y: this.cy + dx * s + dy * c }
  }

  docToScreen(x: number, y: number): Pt {
    const dx = x - this.cx
    const dy = y - this.cy
    const c = Math.cos(this.rotation)
    const s = Math.sin(this.rotation)
    return {
      x: this.vw / 2 + (dx * c - dy * s) * this.scale,
      y: this.vh / 2 + (dx * s + dy * c) * this.scale
    }
  }

  /** Pin a document point to a screen point. Zoom-at-cursor and pinch both
   *  reduce to this, which is why neither drifts. */
  anchor(doc: Pt, screen: Pt): void {
    const dx = (screen.x - this.vw / 2) / this.scale
    const dy = (screen.y - this.vh / 2) / this.scale
    const c = Math.cos(-this.rotation)
    const s = Math.sin(-this.rotation)
    this.cx = doc.x - (dx * c - dy * s)
    this.cy = doc.y - (dx * s + dy * c)
  }

  zoomAt(factor: number, screen: Pt): void {
    const before = this.screenToDoc(screen.x, screen.y)
    this.scale = clamp(this.scale * factor, MIN_ZOOM, MAX_ZOOM)
    this.anchor(before, screen)
  }

  panBy(dxScreen: number, dyScreen: number): void {
    const c = Math.cos(-this.rotation)
    const s = Math.sin(-this.rotation)
    this.cx -= (dxScreen * c - dyScreen * s) / this.scale
    this.cy -= (dxScreen * s + dyScreen * c) / this.scale
  }

  fit(docWidth: number, docHeight: number, margin = 0.92): void {
    this.scale = Math.min(this.vw / docWidth, this.vh / docHeight) * margin
    this.cx = docWidth / 2
    this.cy = docHeight / 2
    this.rotation = 0
  }

  reset(docWidth: number, docHeight: number): void {
    this.scale = 1
    this.rotation = 0
    this.cx = docWidth / 2
    this.cy = docHeight / 2
  }
}
