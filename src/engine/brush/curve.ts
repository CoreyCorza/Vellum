import { clamp } from '../types'

export interface CurvePoint {
  x: number
  y: number
}

/** Control points, sorted by x, with x[0] === 0 and x[last] === 1. */
export type Curve = CurvePoint[]

export const LINEAR_CURVE: Curve = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]

/** Points approximating `x^gamma`, so old exponent-based presets survive. */
export function gammaCurve(gamma: number, steps = 5): Curve {
  const pts: Curve = []
  for (let i = 0; i <= steps; i++) {
    const x = i / steps
    pts.push({ x, y: clamp(Math.pow(x, gamma), 0, 1) })
  }
  return pts
}

const LUT_SIZE = 257

/**
 * Samples a curve via a cached lookup table.
 *
 * Interpolation is monotone cubic (Fritsch–Carlson), not plain Catmull-Rom.
 * That matters here: an ordinary spline overshoots between control points, and
 * an overshooting *pressure* curve means light pressure can produce more ink
 * than the point you placed asked for — or dip below zero and drop out
 * entirely. Monotone interpolation cannot wiggle outside the values you set.
 *
 * The LUT exists because this is evaluated several times per dab, thousands of
 * times a stroke. It is rebuilt only when the curve object identity changes,
 * which is why the editor must emit a new array rather than mutate in place.
 */
export class CurveSampler {
  private lut = new Float32Array(LUT_SIZE)
  private built: Curve | null = null

  sample(curve: Curve, t: number): number {
    if (curve !== this.built) this.build(curve)
    const u = clamp(t, 0, 1) * (LUT_SIZE - 1)
    const i = Math.floor(u)
    if (i >= LUT_SIZE - 1) return this.lut[LUT_SIZE - 1]
    const f = u - i
    return this.lut[i] + (this.lut[i + 1] - this.lut[i]) * f
  }

  private build(curve: Curve): void {
    this.built = curve
    const pts = curve.length >= 2 ? curve : LINEAR_CURVE
    const n = pts.length

    // secants
    const d: number[] = new Array(n - 1)
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x
      d[i] = dx > 1e-9 ? (pts[i + 1].y - pts[i].y) / dx : 0
    }

    // tangents, then the Fritsch–Carlson limiter that guarantees monotonicity
    const m: number[] = new Array(n)
    m[0] = d[0]
    m[n - 1] = d[n - 2]
    for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0
        m[i + 1] = 0
        continue
      }
      const a = m[i] / d[i]
      const b = m[i + 1] / d[i]
      const s = a * a + b * b
      if (s > 9) {
        const tau = 3 / Math.sqrt(s)
        m[i] = tau * a * d[i]
        m[i + 1] = tau * b * d[i]
      }
    }

    let seg = 0
    for (let k = 0; k < LUT_SIZE; k++) {
      const x = k / (LUT_SIZE - 1)
      while (seg < n - 2 && x > pts[seg + 1].x) seg++
      const p0 = pts[seg]
      const p1 = pts[seg + 1]
      const h = p1.x - p0.x
      if (h <= 1e-9) {
        this.lut[k] = clamp(p1.y, 0, 1)
        continue
      }
      const t = clamp((x - p0.x) / h, 0, 1)
      const t2 = t * t
      const t3 = t2 * t
      const h00 = 2 * t3 - 3 * t2 + 1
      const h10 = t3 - 2 * t2 + t
      const h01 = -2 * t3 + 3 * t2
      const h11 = t3 - t2
      this.lut[k] = clamp(
        h00 * p0.y + h10 * h * m[seg] + h01 * p1.y + h11 * h * m[seg + 1],
        0,
        1
      )
    }
  }
}

/** Insert/replace/remove helpers the editor uses. Always return new arrays —
 *  the sampler caches on object identity. */
export function withPointMoved(curve: Curve, index: number, x: number, y: number): Curve {
  const next = curve.map((p) => ({ ...p }))
  const isEnd = index === 0 || index === next.length - 1
  // Endpoints stay pinned to 0 and 1 so the curve always spans the full input
  // range; their height is still free.
  const nx = isEnd ? next[index].x : clamp(x, next[index - 1].x + 0.01, next[index + 1].x - 0.01)
  next[index] = { x: nx, y: clamp(y, 0, 1) }
  return next
}

export function withPointAdded(curve: Curve, x: number, y: number): Curve {
  const next = curve.map((p) => ({ ...p }))
  const cx = clamp(x, 0.01, 0.99)
  let i = 0
  while (i < next.length && next[i].x < cx) i++
  next.splice(i, 0, { x: cx, y: clamp(y, 0, 1) })
  return next
}

export function withPointRemoved(curve: Curve, index: number): Curve {
  if (index === 0 || index === curve.length - 1 || curve.length <= 2) return curve
  return curve.filter((_, i) => i !== index).map((p) => ({ ...p }))
}
