import type { Rect } from './types'
import { clamp } from './types'

/**
 * Mutable dirty-region accumulator.
 *
 * Every expensive operation in a paint app — undo capture, compositing,
 * eventually tile allocation — wants "which rectangle actually changed".
 * Growing one of these as dabs land is how a stroke costs a few hundred KB of
 * history instead of a full-canvas snapshot.
 */
export class Bounds {
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  reset(): void {
    this.minX = Infinity
    this.minY = Infinity
    this.maxX = -Infinity
    this.maxY = -Infinity
  }

  get isEmpty(): boolean {
    return this.maxX < this.minX
  }

  /** Add a point, optionally with a radius around it. */
  add(x: number, y: number, r = 0): void {
    if (x - r < this.minX) this.minX = x - r
    if (y - r < this.minY) this.minY = y - r
    if (x + r > this.maxX) this.maxX = x + r
    if (y + r > this.maxY) this.maxY = y + r
  }

  addRect(r: Rect): void {
    this.add(r.x, r.y)
    this.add(r.x + r.w, r.y + r.h)
  }

  /** Snap outward to whole pixels, pad, and clip to the document. */
  toRect(maxW: number, maxH: number, pad = 2): Rect {
    if (this.isEmpty) return { x: 0, y: 0, w: 0, h: 0 }
    const x = clamp(Math.floor(this.minX) - pad, 0, maxW)
    const y = clamp(Math.floor(this.minY) - pad, 0, maxH)
    const x2 = clamp(Math.ceil(this.maxX) + pad, 0, maxW)
    const y2 = clamp(Math.ceil(this.maxY) + pad, 0, maxH)
    return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) }
  }
}

export const rectArea = (r: Rect): number => r.w * r.h
export const rectIsEmpty = (r: Rect): boolean => r.w <= 0 || r.h <= 0

export function rectUnion(a: Rect, b: Rect): Rect {
  if (rectIsEmpty(a)) return { ...b }
  if (rectIsEmpty(b)) return { ...a }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Circle vs rect, used to skip dabs that cannot touch the selection AABB. */
export function circleHitsRect(x: number, y: number, r: number, box: Rect): boolean {
  const nx = clamp(x, box.x, box.x + box.w)
  const ny = clamp(y, box.y, box.y + box.h)
  const dx = x - nx
  const dy = y - ny
  return dx * dx + dy * dy <= r * r
}
