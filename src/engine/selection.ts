import { Surface } from './surface'
import { Bounds, rectIsEmpty, rectUnion } from './bounds'
import type { SymmetryMode } from './brush/settings'
import type { Pt, Rect } from './types'

/** Affine of the form p' = (p - origin) * scale + origin + delta. */
export interface PixelTransform {
  dx: number
  dy: number
  sx: number
  sy: number
  ox: number
  oy: number
}

export const IDENTITY_TRANSFORM: PixelTransform = {
  dx: 0,
  dy: 0,
  sx: 1,
  sy: 1,
  ox: 0,
  oy: 0
}

export function isIdentityTransform(t: PixelTransform): boolean {
  return t.dx === 0 && t.dy === 0 && t.sx === 1 && t.sy === 1
}

export interface SelectionSnapshot {
  active: boolean
  rect: Rect
  mask: Surface | null
}

const MASK_ON = '#ffffff'

/**
 * A selection is a mask Surface. Alpha > 0 means selected. The mask is the
 * source of truth for clipping paint and for transforming pixels; vector
 * contours are a display convenience built from the last gesture.
 *
 * Symmetry lockstep: any shape written into the mask is immediately OR-ed with
 * its mirrors about the document centre, the same way StrokeEngine stamps
 * mirrored dabs. Transforming then applies the user's affine to the canonical
 * half (x <= cx, y <= cy as required) and re-mirrors the result, so the other
 * side(s) stay in lockstep without being translated by the same delta.
 */
export class Selection {
  readonly mask: Surface
  readonly width: number
  readonly height: number

  private _active = false
  private readonly bounds = new Bounds()
  /** Scratch canvases, document-sized, reused for symmetry and transforms. */
  private readonly workA: Surface
  private readonly workB: Surface

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.mask = new Surface(width, height)
    this.workA = new Surface(width, height)
    this.workB = new Surface(width, height)
  }

  get active(): boolean {
    return this._active
  }

  /** Axis-aligned bounds of currently selected pixels, clipped to the document. */
  get rect(): Rect {
    return this.bounds.toRect(this.width, this.height, 0)
  }

  contains(x: number, y: number): boolean {
    if (!this._active) return false
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return false
    return this.mask.sample(ix, iy)[3] > 8
  }

  clear(): void {
    this.mask.clear()
    this.bounds.reset()
    this._active = false
  }

  snapshot(): SelectionSnapshot {
    if (!this._active) {
      return { active: false, rect: { x: 0, y: 0, w: 0, h: 0 }, mask: null }
    }
    const rect = this.rect
    if (rectIsEmpty(rect)) {
      return { active: false, rect, mask: null }
    }
    return { active: true, rect, mask: this.mask.extract(rect) }
  }

  restore(snap: SelectionSnapshot): void {
    this.mask.clear()
    this.bounds.reset()
    if (!snap.active || !snap.mask || rectIsEmpty(snap.rect)) {
      this._active = false
      return
    }
    this.mask.restore(snap.mask, snap.rect.x, snap.rect.y)
    this.bounds.addRect(snap.rect)
    this._active = true
  }

  selectAll(): void {
    this.mask.fill(MASK_ON)
    this.bounds.reset()
    this.bounds.add(0, 0)
    this.bounds.add(this.width, this.height)
    this._active = true
  }

  setRect(x: number, y: number, w: number, h: number, symmetry: SymmetryMode): void {
    const r = normalisedRect(x, y, w, h)
    this.mask.clear()
    this.bounds.reset()
    if (rectIsEmpty(r)) {
      this._active = false
      return
    }
    this.mask.ctx.fillStyle = MASK_ON
    this.mask.ctx.fillRect(r.x, r.y, r.w, r.h)
    this.bounds.addRect(r)
    this.applySymmetry(symmetry)
    this._active = !this.bounds.isEmpty
  }

  setEllipse(x: number, y: number, w: number, h: number, symmetry: SymmetryMode): void {
    const r = normalisedRect(x, y, w, h)
    this.mask.clear()
    this.bounds.reset()
    if (rectIsEmpty(r) || r.w < 1 || r.h < 1) {
      this._active = false
      return
    }
    const c = this.mask.ctx
    c.save()
    c.fillStyle = MASK_ON
    c.beginPath()
    c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
    c.fill()
    c.restore()
    this.bounds.addRect(r)
    this.applySymmetry(symmetry)
    this._active = !this.bounds.isEmpty
  }

  setLasso(points: readonly Pt[], symmetry: SymmetryMode): void {
    this.mask.clear()
    this.bounds.reset()
    if (points.length < 3) {
      this._active = false
      return
    }
    const c = this.mask.ctx
    c.save()
    c.fillStyle = MASK_ON
    c.beginPath()
    c.moveTo(points[0].x, points[0].y)
    this.bounds.add(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) {
      c.lineTo(points[i].x, points[i].y)
      this.bounds.add(points[i].x, points[i].y)
    }
    c.closePath()
    c.fill()
    c.restore()
    this.applySymmetry(symmetry)
    this._active = !this.bounds.isEmpty
  }

  /**
   * OR the current mask with its mirrors about the document centre. Idempotent
   * on an already-symmetric mask. No-op when symmetry is off.
   */
  applySymmetry(mode: SymmetryMode): void {
    if (mode === 'none' || this.bounds.isEmpty) return
    this.workA.copyFrom(this.mask)
    blitMirrors(this.mask, this.workA, mode)
    this.mirrorBounds(mode)
    this._active = true
  }

  /**
   * Move / scale the selected pixels of `layer` and the mask together.
   * With symmetry, the affine is applied to the canonical half and the result
   * is re-mirrored about the document centre so both sides stay in lockstep.
   */
  transform(layer: Surface, t: PixelTransform, symmetry: SymmetryMode): void {
    if (!this._active) return
    const xf = snappedTransform(t)

    this.workA.copyFrom(layer)
    this.workA.draw(this.mask, 1, 'destination-in')
    layer.draw(this.mask, 1, 'destination-out')

    restrictCanonical(this.workA, symmetry)
    this.workB.clear()
    blitAffine(this.workA, this.workB, xf)
    blitMirrors(this.workB, this.workB, symmetry)
    layer.draw(this.workB)

    this.workA.copyFrom(this.mask)
    restrictCanonical(this.workA, symmetry)
    this.mask.clear()
    blitAffine(this.workA, this.mask, xf)
    blitMirrors(this.mask, this.mask, symmetry)

    this.transformBounds(xf, symmetry)
    this._active = !this.bounds.isEmpty
  }

  /** Conservative AABB after `t`, used to size the undo patch before mutating. */
  boundsAfter(t: PixelTransform, symmetry: SymmetryMode): Rect {
    const xf = snappedTransform(t)
    const r = this.rect
    if (rectIsEmpty(r)) return r
    const b = new Bounds()
    const corners: Pt[] = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x, y: r.y + r.h },
      { x: r.x + r.w, y: r.y + r.h }
    ]
    for (const p of corners) {
      const q = applyTransform(p, xf)
      addPointWithMirrors(b, q.x, q.y, symmetry, this.width, this.height)
    }
    return b.toRect(this.width, this.height, 2)
  }

  private transformBounds(t: PixelTransform, symmetry: SymmetryMode): void {
    const r = this.rect
    this.bounds.reset()
    if (rectIsEmpty(r)) {
      this._active = false
      return
    }
    const corners: Pt[] = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x, y: r.y + r.h },
      { x: r.x + r.w, y: r.y + r.h }
    ]
    for (const p of corners) {
      const q = applyTransform(p, t)
      addPointWithMirrors(this.bounds, q.x, q.y, symmetry, this.width, this.height)
    }
  }

  private mirrorBounds(mode: SymmetryMode): void {
    if (mode === 'none' || this.bounds.isEmpty) return
    const minX = this.bounds.minX
    const minY = this.bounds.minY
    const maxX = this.bounds.maxX
    const maxY = this.bounds.maxY
    addPointWithMirrors(this.bounds, minX, minY, mode, this.width, this.height)
    addPointWithMirrors(this.bounds, maxX, minY, mode, this.width, this.height)
    addPointWithMirrors(this.bounds, minX, maxY, mode, this.width, this.height)
    addPointWithMirrors(this.bounds, maxX, maxY, mode, this.width, this.height)
  }
}

export function normalisedRect(x: number, y: number, w: number, h: number): Rect {
  const x0 = w < 0 ? x + w : x
  const y0 = h < 0 ? y + h : y
  return { x: x0, y: y0, w: Math.abs(w), h: Math.abs(h) }
}

export function applyTransform(p: Pt, t: PixelTransform): Pt {
  return {
    x: (p.x - t.ox) * t.sx + t.ox + t.dx,
    y: (p.y - t.oy) * t.sy + t.oy + t.dy
  }
}

export function addPointWithMirrors(
  b: Bounds,
  x: number,
  y: number,
  mode: SymmetryMode,
  width: number,
  height: number
): void {
  b.add(x, y)
  const cx = width / 2
  const cy = height / 2
  if (mode === 'x' || mode === 'xy') b.add(2 * cx - x, y)
  if (mode === 'y' || mode === 'xy') b.add(x, 2 * cy - y)
  if (mode === 'xy') b.add(2 * cx - x, 2 * cy - y)
}

export function unionRect(a: Rect, b: Rect): Rect {
  return rectUnion(a, b)
}

function snappedTransform(t: PixelTransform): PixelTransform {
  if (t.sx === 1 && t.sy === 1) {
    return { ...t, dx: Math.round(t.dx), dy: Math.round(t.dy) }
  }
  return t
}

function restrictCanonical(s: Surface, mode: SymmetryMode): void {
  if (mode === 'none') return
  const w = s.width
  const h = s.height
  const cx = Math.ceil(w / 2)
  const cy = Math.ceil(h / 2)
  if (mode === 'x' || mode === 'xy') s.clear({ x: cx, y: 0, w: w - cx, h })
  if (mode === 'y' || mode === 'xy') s.clear({ x: 0, y: cy, w, h: h - cy })
}

function blitAffine(src: Surface, dest: Surface, t: PixelTransform): void {
  const c = dest.ctx
  c.save()
  c.imageSmoothingEnabled = t.sx !== 1 || t.sy !== 1
  c.imageSmoothingQuality = 'high'
  c.translate(t.ox + t.dx, t.oy + t.dy)
  c.scale(t.sx, t.sy)
  c.translate(-t.ox, -t.oy)
  c.drawImage(src.canvas, 0, 0)
  c.restore()
}

/**
 * OR `src` (pre-mirror) into `dest` at every symmetry copy. `src` may be `dest`
 * itself — we snapshot first in that case via the fact that the caller passes
 * a copy, except for the in-place workB path where dest already holds the
 * canonical half and we blit from a snapshot.
 */
function blitMirrors(dest: Surface, src: Surface, mode: SymmetryMode): void {
  if (mode === 'none') return
  const w = dest.width
  const h = dest.height
  // Snapshot so drawing a flip of dest into dest is well-defined.
  const from = src === dest ? snapshotCanvas(src) : src.canvas
  const c = dest.ctx
  c.save()
  c.globalCompositeOperation = 'source-over'
  if (mode === 'x' || mode === 'xy') {
    c.save()
    c.translate(w, 0)
    c.scale(-1, 1)
    c.drawImage(from, 0, 0)
    c.restore()
  }
  if (mode === 'y' || mode === 'xy') {
    c.save()
    c.translate(0, h)
    c.scale(1, -1)
    c.drawImage(from, 0, 0)
    c.restore()
  }
  if (mode === 'xy') {
    c.save()
    c.translate(w, h)
    c.scale(-1, -1)
    c.drawImage(from, 0, 0)
    c.restore()
  }
  c.restore()
}

let mirrorSnap: HTMLCanvasElement | null = null

function snapshotCanvas(s: Surface): HTMLCanvasElement {
  if (!mirrorSnap || mirrorSnap.width !== s.width || mirrorSnap.height !== s.height) {
    mirrorSnap = document.createElement('canvas')
    mirrorSnap.width = s.width
    mirrorSnap.height = s.height
  }
  const x = mirrorSnap.getContext('2d')
  if (!x) throw new Error('Selection: could not snapshot')
  x.save()
  x.globalCompositeOperation = 'copy'
  x.drawImage(s.canvas, 0, 0)
  x.restore()
  return mirrorSnap
}
