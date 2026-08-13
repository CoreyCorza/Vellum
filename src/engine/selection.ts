import { Surface } from './surface'
import { Bounds, rectIsEmpty, rectUnion } from './bounds'
import type { SymmetryMode } from './brush/settings'
import type { Pt, Rect } from './types'

/**
 * Affine of the form p' = origin + rotate(scale(p - origin)) + delta.
 *
 * Scale first, then rotate, then translate. The order matters and this one is chosen because it is
 * what a handle drag means: you size the box, and separately you turn it, both about the same pivot.
 */
export interface PixelTransform {
  dx: number
  dy: number
  sx: number
  sy: number
  ox: number
  oy: number
  /** Radians, anticlockwise on screen, about the origin. */
  rot: number
}

export const IDENTITY_TRANSFORM: PixelTransform = {
  dx: 0,
  dy: 0,
  sx: 1,
  sy: 1,
  ox: 0,
  oy: 0,
  rot: 0
}

/**
 * A general 2x3 affine, for accumulating a whole transform session.
 *
 * PixelTransform describes ONE handle drag: a scale and a rotation about a single pivot, plus an
 * offset. Two of those in a row cannot always be written as a third — a non-uniform scale followed
 * by a rotation shears, and no pivot-and-angle description can hold that. So a session that lets you
 * move, then scale, then rotate the same pixels needs the general form.
 */
export interface Mat {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY_MAT: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** The matrix for one handle drag: translate, rotate, scale, translate back. */
export function matFromTransform(t: PixelTransform): Mat {
  const cos = Math.cos(t.rot)
  const sin = Math.sin(t.rot)
  // R * S
  const a = cos * t.sx
  const b = sin * t.sx
  const c = -sin * t.sy
  const d = cos * t.sy
  // Then place it so the pivot maps to pivot + delta.
  return {
    a,
    b,
    c,
    d,
    e: t.ox + t.dx - (a * t.ox + c * t.oy),
    f: t.oy + t.dy - (b * t.ox + d * t.oy)
  }
}

/** `m` applied after `n`. */
export function matMul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f
  }
}

export function matApply(m: Mat, p: Pt): Pt {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function isIdentityMat(m: Mat): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
}

/**
 * The same matrix seen from the other side of a mirror: F * M * F, where F is the reflection.
 *
 * Used for everything that must travel with the copy the user grabbed rather than with the canonical
 * half the pixels are transformed on.
 */
export function matMirror(m: Mat, flipX: boolean, flipY: boolean, w: number, h: number): Mat {
  if (!flipX && !flipY) return m
  const sx = flipX ? -1 : 1
  const sy = flipY ? -1 : 1
  const tx = flipX ? w : 0
  const ty = flipY ? h : 0
  const F: Mat = { a: sx, b: 0, c: 0, d: sy, e: tx, f: ty }
  return matMul(F, matMul(m, F))
}

/**
 * Whole-pixel translation when the matrix is nothing but a translation.
 *
 * A pure move can be exact, so it is: dragging something away and back returns the pixels it started
 * with. Once there is a scale or a rotation the pixels are resampled anyway and rounding the offset
 * would add a second error on top of the first.
 */
export function snapMat(m: Mat): Mat {
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) {
    return { ...m, e: Math.round(m.e), f: Math.round(m.f) }
  }
  return m
}

export function isIdentityTransform(t: PixelTransform): boolean {
  return t.dx === 0 && t.dy === 0 && t.sx === 1 && t.sy === 1 && t.rot === 0
}

/**
 * Selected pixels lifted off a layer, waiting to be put back somewhere else.
 *
 * Cropped rather than document-sized: a transform preview redraws this on every pointer move, and a
 * small blit is free where a full-canvas one is not.
 */
export interface FloatingPixels {
  pixels: HTMLCanvasElement
  mask: HTMLCanvasElement
  /** Where these pixels came from — the canonical half's bounds under symmetry. */
  from: Rect
  /** The whole selection's bounds, both halves, for sizing an undo patch. */
  selectedRect: Rect
}

export interface SelectionSnapshot {
  active: boolean
  rect: Rect
  mask: Surface | null
  /** Carried so undo restores the shape of the ants, not just what is selected. */
  outline: Pt[]
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
  /**
   * The selection's outline in document space, as a polygon.
   *
   * The mask is the truth for what is selected; this exists only so the marching ants can trace the
   * actual shape. Without it an ellipse or a lasso is drawn as its bounding box, which tells you the
   * wrong thing about what you selected.
   *
   * One representation for all three shapes — a rectangle is four points, an ellipse is sampled —
   * so transforming an outline is the same code whatever made it.
   */
  private _outline: Pt[] = []
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

  /** The outline in document space. Empty when nothing is selected. */
  get outline(): readonly Pt[] {
    return this._outline
  }

  /**
   * Bounds of the shape as drawn, before symmetry mirrors it.
   *
   * This is what transform handles belong on. `rect` covers every selected pixel, which under
   * symmetry means one box spanning both halves and most of the document — a 150 px selection
   * reported bounds 1448 px wide, so the handles ended up scattered around the far edges of the
   * canvas with nothing near the thing being dragged.
   */
  get outlineRect(): Rect {
    if (this._outline.length === 0) return this.rect
    const b = new Bounds()
    for (const q of this._outline) b.add(q.x, q.y)
    return b.toRect(this.width, this.height, 0)
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
    this._outline = []
    this._active = false
  }

  snapshot(): SelectionSnapshot {
    if (!this._active) {
      return { active: false, rect: { x: 0, y: 0, w: 0, h: 0 }, mask: null, outline: [] }
    }
    const rect = this.rect
    if (rectIsEmpty(rect)) {
      return { active: false, rect, mask: null, outline: [] }
    }
    return { active: true, rect, mask: this.mask.extract(rect), outline: this._outline.map((q) => ({ ...q })) }
  }

  restore(snap: SelectionSnapshot): void {
    this.mask.clear()
    this.bounds.reset()
    this._outline = snap.outline ? snap.outline.map((q) => ({ ...q })) : []
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
    this._outline = [
      { x: 0, y: 0 },
      { x: this.width, y: 0 },
      { x: this.width, y: this.height },
      { x: 0, y: this.height }
    ]
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
    this._outline = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h }
    ]
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
    // Sampled finely enough that the ants read as a curve at any sane zoom.
    const steps = 96
    const mx = r.x + r.w / 2
    const my = r.y + r.h / 2
    this._outline = []
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      this._outline.push({ x: mx + (r.w / 2) * Math.cos(a), y: my + (r.h / 2) * Math.sin(a) })
    }
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
    this._outline = points.map((q) => ({ x: q.x, y: q.y }))
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
   * Cut the selected pixels out of `layer` and hand them back as a floating buffer.
   *
   * Called once, when a transform gesture starts. Everything after that is drawing: the layer
   * already has its hole, the pixels are in hand, and moving them is a matter of where they get
   * drawn rather than of editing the document. That is what makes a transform preview free and
   * artefact-free — nothing is written to the layer until the gesture ends, so there is no
   * partially-applied state to leave residue behind.
   *
   * With symmetry on, only the canonical half is lifted. The other half is not carried around; it
   * is regenerated by mirroring whatever the canonical half becomes, which is what keeps the two
   * sides in lockstep instead of both sliding the same way.
   *
   * The buffer is cropped to the selection rather than being document-sized, so redrawing it as the
   * pointer moves costs a small blit instead of a full canvas.
   */
  lift(layer: Surface, symmetry: SymmetryMode): FloatingPixels | null {
    if (!this._active) return null
    const from = this.rect
    if (rectIsEmpty(from)) return null

    this.workA.copyFrom(layer)
    this.workA.draw(this.mask, 1, 'destination-in')
    restrictCanonical(this.workA, symmetry)

    this.workB.copyFrom(this.mask)
    restrictCanonical(this.workB, symmetry)

    // Cropped to the canonical half's own bounds, which after restriction may be smaller than the
    // whole selection.
    const canon = canonicalRect(from, symmetry, this.width, this.height)
    if (rectIsEmpty(canon)) return null

    const pixels = cropped(this.workA, canon)
    const mask = cropped(this.workB, canon)

    // The hole. Cut with the FULL mask, not the canonical half, so both sides lift together.
    layer.draw(this.mask, 1, 'destination-out')

    return { pixels, mask, from: canon, selectedRect: from }
  }

  /**
   * Draw a floating buffer, transformed, into `dest`. Used for the live preview and for the commit,
   * so what is shown during the drag and what lands at the end cannot disagree.
   */
  renderFloat(dest: Surface, f: FloatingPixels, m: Mat, symmetry: SymmetryMode): void {
    const xf = snapMat(m)
    dest.clear()
    blitFloat(f.pixels, f.from, dest, xf)
    blitMirrors(dest, dest, symmetry)
  }

  /**
   * Stamp the float into the layer for good and move the mask to match.
   *
   * The mask is transformed by the same affine as the pixels, so the selection stays around the
   * content it belongs to and a second drag starts from where the first one finished.
   */
  commit(
    layer: Surface,
    f: FloatingPixels,
    m: Mat,
    symmetry: SymmetryMode,
    /**
     * How the outline moves, which is not always how the pixels move.
     *
     * The pixels are transformed on the canonical half; the outline lives wherever the user drew it.
     * When that is the mirrored side, the two need matrices that are reflections of each other.
     */
    outlineM: Mat = m,
    /** The outline as it was when the session started, since the matrix is measured from there. */
    baseOutline: readonly Pt[] = this._outline
  ): void {
    const xf = snapMat(m)

    this.renderFloat(this.workB, f, xf, symmetry)
    layer.draw(this.workB)

    this.mask.clear()
    blitFloat(f.mask, f.from, this.mask, xf)
    blitMirrors(this.mask, this.mask, symmetry)

    this._outline = baseOutline.map((q) => matApply(outlineM, q))
    this.boundsFromOutline(symmetry)
    this._active = !this.bounds.isEmpty
  }

  /**
   * Rebuild the bounds from the outline and its mirrors.
   *
   * Replaces transforming the previous bounds' corners, which was only right for a translation: the
   * corners of an axis-aligned box do not stay the corners of the shape once it is rotated, so the
   * box grew a little on every turn.
   */
  private boundsFromOutline(symmetry: SymmetryMode): void {
    this.bounds.reset()
    for (const q of this._outline) {
      addPointWithMirrors(this.bounds, q.x, q.y, symmetry, this.width, this.height)
    }
  }

  /** Conservative AABB after `t`, used to size the undo patch before mutating. */
  boundsAfter(m: Mat, symmetry: SymmetryMode): Rect {
    if (this._outline.length === 0) return this.rect
    const b = new Bounds()
    for (const p of this._outline) {
      const q = matApply(m, p)
      addPointWithMirrors(b, q.x, q.y, symmetry, this.width, this.height)
    }
    return b.toRect(this.width, this.height, 2)
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

/**
 * The same transform as seen from the other side of a mirror.
 *
 * Under symmetry the pixels are transformed on the canonical half, so a drag on the mirrored copy is
 * expressed in canonical coordinates. Anything that has to move WITH the copy the user grabbed — the
 * outline, the handles — needs that transform conjugated by the mirror, or it travels the opposite
 * way. Which is exactly what happened: dragging the right smiley rightwards sent its outline left.
 *
 * Mirroring about w (matching blitMirrors, which maps x to w - x) turns out to need only a sign flip
 * on the offset and a reflection of the scale origin.
 */
export function mirrorTransform(
  t: PixelTransform,
  flipX: boolean,
  flipY: boolean,
  w: number,
  h: number
): PixelTransform {
  return {
    dx: flipX ? -t.dx : t.dx,
    dy: flipY ? -t.dy : t.dy,
    sx: t.sx,
    sy: t.sy,
    ox: flipX ? w - t.ox : t.ox,
    oy: flipY ? h - t.oy : t.oy,
    /*
     * A reflection reverses which way round is anticlockwise, so a rotation seen through one mirror
     * turns the other way — which is what makes a rotated symmetric pair stay symmetric instead of
     * both halves turning the same direction. Through two mirrors the reversal happens twice and
     * cancels.
     */
    rot: flipX !== flipY ? -t.rot : t.rot
  }
}

/** A point seen from the other side of a mirror. */
export function mirrorPoint(p: Pt, flipX: boolean, flipY: boolean, w: number, h: number): Pt {
  return { x: flipX ? w - p.x : p.x, y: flipY ? h - p.y : p.y }
}

/** A rect seen from the other side of a mirror. */
export function mirrorRect(r: Rect, flipX: boolean, flipY: boolean, w: number, h: number): Rect {
  return {
    x: flipX ? w - (r.x + r.w) : r.x,
    y: flipY ? h - (r.y + r.h) : r.y,
    w: r.w,
    h: r.h
  }
}

export function applyTransform(p: Pt, t: PixelTransform): Pt {
  const ux = (p.x - t.ox) * t.sx
  const uy = (p.y - t.oy) * t.sy
  if (t.rot === 0) return { x: t.ox + ux + t.dx, y: t.oy + uy + t.dy }
  const c = Math.cos(t.rot)
  const s = Math.sin(t.rot)
  return {
    x: t.ox + ux * c - uy * s + t.dx,
    y: t.oy + ux * s + uy * c + t.dy
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

/**
 * Whole-pixel translation when nothing else is happening.
 *
 * A pure move can be exact, so it is: no resampling, no softening, and dragging something away and
 * back returns the pixels it started with. Once a scale or a rotation is involved the pixels have to
 * be resampled anyway and rounding the offset would only add a second error on top.
 */

function restrictCanonical(s: Surface, mode: SymmetryMode): void {
  if (mode === 'none') return
  const w = s.width
  const h = s.height
  const cx = Math.ceil(w / 2)
  const cy = Math.ceil(h / 2)
  if (mode === 'x' || mode === 'xy') s.clear({ x: cx, y: 0, w: w - cx, h })
  if (mode === 'y' || mode === 'xy') s.clear({ x: 0, y: cy, w, h: h - cy })
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

/** The part of `r` that survives restriction to the canonical half. */
function canonicalRect(r: Rect, mode: SymmetryMode, w: number, h: number): Rect {
  if (mode === 'none') return r
  const cx = Math.ceil(w / 2)
  const cy = Math.ceil(h / 2)
  let { x, y } = r
  let right = r.x + r.w
  let bottom = r.y + r.h
  if (mode === 'x' || mode === 'xy') right = Math.min(right, cx)
  if (mode === 'y' || mode === 'xy') bottom = Math.min(bottom, cy)
  x = Math.max(0, x)
  y = Math.max(0, y)
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}

/** A cropped copy of part of a surface, as a plain canvas. */
function cropped(s: Surface, r: Rect): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(r.w))
  c.height = Math.max(1, Math.round(r.h))
  const x = c.getContext('2d')
  if (!x) throw new Error('Selection: could not crop')
  x.drawImage(s.canvas, r.x, r.y, c.width, c.height, 0, 0, c.width, c.height)
  return c
}

/**
 * Draw a cropped float back into document space under an affine.
 *
 * The affine is defined on document coordinates, so the crop's own offset has to be applied inside
 * it rather than added afterwards — otherwise scaling moves the piece relative to where it was cut
 * from, and the content creeps away from the selection outline as you resize.
 */
function blitFloat(src: HTMLCanvasElement, from: Rect, dest: Surface, m: Mat): void {
  const c = dest.ctx
  c.save()
  const pureTranslate = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1
  c.imageSmoothingEnabled = !pureTranslate
  c.imageSmoothingQuality = 'high'
  c.transform(m.a, m.b, m.c, m.d, m.e, m.f)
  c.drawImage(src, from.x, from.y)
  c.restore()
}
