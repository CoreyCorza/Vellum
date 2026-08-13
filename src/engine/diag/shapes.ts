import type { RawSample } from './capture'
import { fitLine } from './analysis'

/**
 * Measuring a tablet from ordinary drawn strokes, with no ruler.
 *
 * The ruler was scaffolding. It gave a known intended shape, which is what this problem normally
 * lacks, but it costs a physical object, careful placement, and its own bow — which is fixed to
 * position exactly like a sensor error and cannot be told apart from one on a single straightedge.
 *
 * A person drawing freehand intends a small vocabulary of shapes: a straight line, a C curve, an S
 * curve. None of those needs a ruler to be known, because a smooth curve can be fitted THROUGH the
 * stroke and taken as what was meant. The difference between the samples and that curve is the
 * wobble, and it is measured the same way as before.
 *
 * Two things make this better than the ruler rather than merely cheaper:
 *
 *   A curved stroke sweeps through many directions along its length. Sideways error is a different
 *   mixture of the two axes at every direction, and separating them is precisely what needs a range
 *   of directions — so one S curve does the work of several ruler placements.
 *
 *   There is no straightedge, so there is no straightedge's shape to mistake for the tablet's.
 *
 * What it costs: the fitted curve absorbs slow content, so this measures the ripple and not a slow
 * warp. The ruler had the same limitation for the same reason, and paid an object for it.
 */

export interface ShapeResidual {
  /** Position on the glass. */
  x: number
  y: number
  /** Sideways distance from the intended curve. The wobble. */
  err: number
  /** Direction of travel here, as a unit vector. Varies along a curve, which is the point. */
  dx: number
  dy: number
  /** Distance along the stroke. */
  along: number
}

/**
 * Least squares polynomial through one coordinate against distance along the stroke.
 *
 * Solved on a centred, scaled parameter so the powers stay well conditioned, and by plain
 * elimination because the order is never more than about eight.
 */
function polyThrough(param: readonly number[], value: readonly number[], order: number): number[] {
  const m = order + 1
  const A: number[][] = []
  for (let r = 0; r < m; r++) A.push(new Array<number>(m + 1).fill(0))
  for (let i = 0; i < param.length; i++) {
    const t = param[i]
    const pow = [1]
    for (let k = 1; k < 2 * m; k++) pow.push(pow[k - 1] * t)
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) A[r][c] += pow[r + c]
      A[r][m] += pow[r] * value[i]
    }
  }
  for (let r = 0; r < m; r++) {
    let piv = r
    for (let k = r + 1; k < m; k++) if (Math.abs(A[k][r]) > Math.abs(A[piv][r])) piv = k
    const tmp = A[r]
    A[r] = A[piv]
    A[piv] = tmp
    if (Math.abs(A[r][r]) < 1e-12) continue
    for (let k = r + 1; k < m; k++) {
      const f = A[k][r] / A[r][r]
      for (let c = r; c <= m; c++) A[k][c] -= f * A[r][c]
    }
  }
  const coef = new Array<number>(m).fill(0)
  for (let r = m - 1; r >= 0; r--) {
    let acc = A[r][m]
    for (let c = r + 1; c < m; c++) acc -= A[r][c] * coef[c]
    coef[r] = Math.abs(A[r][r]) < 1e-12 ? 0 : acc / A[r][r]
  }
  return coef
}

const evalPoly = (coef: readonly number[], t: number): number => {
  let acc = 0
  let pw = 1
  for (let i = 0; i < coef.length; i++) {
    acc += coef[i] * pw
    pw *= t
  }
  return acc
}

const evalSlope = (coef: readonly number[], t: number): number => {
  let acc = 0
  let pw = 1
  for (let i = 1; i < coef.length; i++) {
    acc += i * coef[i] * pw
    pw *= t
  }
  return acc
}

/**
 * The intended shape of one drawn stroke, and how far each sample sits from it.
 *
 * The curve can only describe what the arm meant, so everything it cannot reach is what is left to
 * measure. That gap is the whole mechanism.
 */
export function shapeResiduals(pts: readonly RawSample[], order = 12): ShapeResidual[] {
  if (pts.length < 120) return []
  const line = fitLine(pts)

  /*
   * Fitted in the stroke's own frame: sideways offset as a function of distance along it.
   *
   * Fitting x and y separately against distance was hopeless — a degree five polynomial left 5.7 px
   * of residual on a clean S curve with no hand and no distortion present, which is twenty times the
   * thing being measured. In the rotated frame the same shapes are far easier to describe: a line is
   * flat, a C is one hump, an S is one cycle, and a polynomial handles all three to a small fraction
   * of a pixel.
   *
   * Order twelve, chosen by measurement. Order eight left 0.68 px on an aggressive S curve, twice the
   * size of the distortion; twelve leaves 0.065 px, and 0.001 px on a gentle one. It remains stiff
   * where it matters: thirteen coefficients can follow about six bends across a stroke, while the
   * ripple goes through thirty or more cycles over the same distance, so the curve cannot absorb it
   * however hard it tries. That gap between what an arm can intend and what a sensor does is the
   * whole mechanism.
   */
  const along: number[] = []
  const across: number[] = []
  for (const p of pts) {
    const ux = p.x - line.cx
    const uy = p.y - line.cy
    along.push(ux * line.dx + uy * line.dy)
    across.push(ux * -line.dy + uy * line.dx)
  }
  const lo = Math.min(...along)
  const hi = Math.max(...along)
  const span = hi - lo
  if (!(span > 100)) return []

  const t = along.map((v) => (2 * (v - lo)) / span - 1)
  const coef = polyThrough(t, across, order)

  const out: ShapeResidual[] = []
  // Drop the ends: a polynomial is least constrained where it runs out of data, and a pen is doing
  // its least deliberate work there anyway.
  const skip = Math.round(pts.length * 0.06)
  for (let i = skip; i < pts.length - skip; i++) {
    const fitted = evalPoly(coef, t[i])
    // Slope of the fitted curve in the rotated frame, turned back into a direction on the glass.
    const dAcross = (evalSlope(coef, t[i]) * 2) / span
    const len = Math.hypot(1, dAcross)
    const tx = (line.dx + -line.dy * dAcross) / len
    const ty = (line.dy + line.dx * dAcross) / len

    /*
     * Measured perpendicular to the LOCAL tangent, not to the stroke's overall axis.
     *
     * Those two are the same for a straight line and wildly different on a curve — up to forty five
     * degrees apart on a strong S. Reporting the deviation in one frame while handing the fit a
     * direction from the other made the curved strokes, which are the only ones carrying the
     * information that separates the two axes, feed it inconsistent numbers. It looked like a data
     * shortage: more strokes made the answer worse, because more strokes meant more curves.
     */
    const idealX = line.cx + line.dx * along[i] + -line.dy * fitted
    const idealY = line.cy + line.dy * along[i] + line.dx * fitted
    const vx = pts[i].x - idealX
    const vy = pts[i].y - idealY

    out.push({
      x: pts[i].x,
      y: pts[i].y,
      err: vx * -ty + vy * tx,
      dx: tx,
      dy: ty,
      along: along[i] - lo
    })
  }
  return out
}

/**
 * How much of a stroke's length is spent travelling in each direction.
 *
 * Used to tell a stroke that helps from one that does not. A straight line only ever samples one
 * mixture of the two axes; a curve sweeps through a range, and it is the range that makes the two
 * separable. This is what lets the calibration ask for "a few curves" rather than for a ruler at
 * five carefully chosen angles.
 */
export function directionSpread(res: readonly ShapeResidual[]): number {
  if (res.length < 20) return 0
  /*
   * Measured as the smallest arc that contains every direction, on a circle of half a turn.
   *
   * Taking the largest minus the smallest angle is wrong wherever the directions wrap past the join,
   * which an S curve does routinely: its tangents spanned 0.2 to 179.8 degrees and the naive answer
   * came out as 0.4, calling the most useful stroke in the vocabulary the least useful. Sorting the
   * angles and finding the widest empty gap gives the arc they actually occupy.
   */
  const angs = res
    .map((r) => {
      const a = (Math.atan2(r.dy, r.dx) * 180) / Math.PI
      return ((a % 180) + 180) % 180
    })
    .sort((a, b) => a - b)

  let widestGap = angs[0] + 180 - angs[angs.length - 1]
  for (let i = 1; i < angs.length; i++) {
    const gap = angs[i] - angs[i - 1]
    if (gap > widestGap) widestGap = gap
  }
  return Math.max(0, 180 - widestGap)
}
