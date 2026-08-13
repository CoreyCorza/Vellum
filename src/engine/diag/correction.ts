import type { RawSample } from './capture'

/**
 * Cancelling the digitiser's own distortion by subtracting it.
 *
 * The measurements said this is possible: the ripple on a diagonal ruler pass lands in the
 * same places on every pass (0.985 agreement), does not care which direction the pen travels
 * (0.977 reversed), and survives averaging five passes with 99% of its size intact. Those are
 * the fingerprints of a fixed property of the hardware rather than of a hand or of noise.
 *
 * That distinction is the whole point, because it changes what the fix is allowed to cost. A
 * stabiliser removes wobble by refusing to follow the pen immediately, and every artist who
 * has used one knows the price. A fixed error can simply be subtracted: the corrected position
 * depends only on the current sample, so there is no averaging, no window, no delay, and no
 * effect whatsoever on movement that was really there.
 *
 * The model is separable — an offset in x that depends on x, and one in y that depends on y.
 * That is not an arbitrary simplification; it is what explains the observation that started
 * this. On a horizontal pass only x sweeps, so its error pushes the pen along the line where
 * straightness cannot show it, while y contributes a constant offset. Only when both axes
 * sweep does the error turn sideways and become visible, which is why horizontals and
 * verticals feel clean and diagonals do not.
 */

export interface AxisTable {
  /** Width of each bin, in screen pixels. */
  step: number
  /** Centre of the first bin. */
  origin: number
  /** What to subtract from a reported coordinate that falls in this bin. */
  offsets: number[]
  /** Samples that went into each bin, so thinly covered areas can be left alone. */
  weight: number[]
}

export interface Correction {
  x: AxisTable | null
  y: AxisTable | null
  /** What this was measured from, for the record. */
  note?: string
}

/** Bins with less than this much evidence are treated as uncalibrated and left at zero. */
const MIN_WEIGHT = 8

/**
 * The offset for one coordinate, interpolated between bin centres.
 *
 * Interpolated rather than stepped because a staircase correction would replace a smooth
 * ripple with a set of small jumps — quieter by the numbers and worse to draw with.
 */
export function offsetAt(table: AxisTable, v: number): number {
  const n = table.offsets.length
  if (n === 0) return 0
  const t = (v - table.origin) / table.step
  /*
   * Outside the calibrated range, fade to nothing over a couple of bins.
   *
   * Holding the edge value would mean claiming to know what the tablet does somewhere it was
   * never measured, indefinitely. Dropping straight to zero would be honest but would put a
   * step of a third of a pixel exactly at the boundary, and a step is more noticeable than the
   * ripple being removed. Fading does neither.
   */
  const FADE = 2
  if (t <= -FADE || t >= n - 1 + FADE) return 0
  if (t < 0) {
    const edge = table.weight[0] >= MIN_WEIGHT ? table.offsets[0] : 0
    return edge * (1 + t / FADE)
  }
  if (t > n - 1) {
    const edge = table.weight[n - 1] >= MIN_WEIGHT ? table.offsets[n - 1] : 0
    return edge * (1 - (t - (n - 1)) / FADE)
  }
  const i = Math.floor(t)
  const f = t - i
  const a = table.weight[i] >= MIN_WEIGHT ? table.offsets[i] : 0
  const b = table.weight[i + 1] >= MIN_WEIGHT ? table.offsets[i + 1] : 0
  return a * (1 - f) + b * f
}

/** Apply the correction to one sample. Depends on nothing but this sample: no lag. */
export function correct(c: Correction, x: number, y: number): { x: number; y: number } {
  return {
    x: c.x ? x - offsetAt(c.x, x) : x,
    y: c.y ? y - offsetAt(c.y, y) : y
  }
}

/**
 * The wiggle in one coordinate, with the smooth part of the movement removed.
 *
 * On a pass along one axis, that coordinate's own error appears as the pen seeming to hurry
 * and dawdle. A hand hurries and dawdles too, by far more, so a single pass says almost
 * nothing — but the hand's version is not tied to position and averaging many passes cancels
 * it, while the digitiser's version lands in the same places every time and survives. That is
 * exactly the effect measured at 99% on five repeated passes, used here as the instrument.
 *
 * The trend is removed with a centred average over a window measured in samples, wide enough
 * to leave a ripple of a few tens of pixels alone.
 */
export function axisWiggle(
  pts: readonly RawSample[],
  axis: 'x' | 'y',
  halfWindow = 24
): { pos: number[]; wiggle: number[] } {
  const v: number[] = []
  // A repeated position is not evidence; left in, duplicates flatten the ripple being sought.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[i - 1]
    if (q && p.x === q.x && p.y === q.y) continue
    v.push(axis === 'x' ? p.x : p.y)
  }
  const pos: number[] = []
  const wiggle: number[] = []
  /*
   * Only where a full centred window exists.
   *
   * At the ends of a pass the window is one-sided, so it averages the coordinate against
   * samples that are all on one side of it and the difference is not a wiggle at all — it is
   * most of the distance the pen covered during the window. On a pass moving 1.8 px per sample
   * that produced residuals of twenty pixels, and since every pass starts at roughly the same
   * place those landed in the same bins and buried the real 0.2 px signal twelvefold.
   */
  for (let i = halfWindow; i < v.length - halfWindow; i++) {
    let mean = 0
    for (let k = i - halfWindow; k <= i + halfWindow; k++) mean += v[k]
    mean /= halfWindow * 2 + 1
    pos.push(v[i])
    wiggle.push(v[i] - mean)
  }
  return { pos, wiggle }
}

/**
 * Build a table for one axis by averaging many passes into bins of position.
 *
 * Averaging is the entire mechanism. Anything not tied to position — the hand, the noise —
 * averages towards nothing as passes accumulate, and what is left is what the tablet does at
 * each place. More passes is strictly better, which is why the calibration asks for a lot of
 * them rather than a careful few.
 */
export function buildAxisTable(
  passes: readonly { pos: number[]; wiggle: number[] }[],
  step = 4
): AxisTable | null {
  let lo = Infinity
  let hi = -Infinity
  for (const p of passes) {
    for (const v of p.pos) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (!(hi > lo)) return null

  const bins = Math.max(2, Math.ceil((hi - lo) / step) + 1)
  const sum = new Array<number>(bins).fill(0)
  const weight = new Array<number>(bins).fill(0)
  for (const p of passes) {
    for (let i = 0; i < p.pos.length; i++) {
      const b = Math.min(bins - 1, Math.max(0, Math.round((p.pos[i] - lo) / step)))
      sum[b] += p.wiggle[i]
      weight[b]++
    }
  }
  const offsets = sum.map((s, i) => (weight[i] > 0 ? s / weight[i] : 0))

  /*
   * Remove any overall tilt or shift from the finished table.
   *
   * A correction is only entitled to remove the wiggle. A constant offset would move the whole
   * drawing sideways and a slope would stretch it, and neither is what was measured — both are
   * artefacts of averaging a finite number of passes. Left in, the correction would slowly
   * distort the coordinate system it was supposed to be fixing.
   */
  let n = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < bins; i++) {
    if (weight[i] < MIN_WEIGHT) continue
    n++
    sx += i
    sy += offsets[i]
    sxx += i * i
    sxy += i * offsets[i]
  }
  if (n >= 2) {
    const denom = n * sxx - sx * sx
    const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0
    const intercept = (sy - slope * sx) / n
    for (let i = 0; i < bins; i++) offsets[i] -= intercept + slope * i
  }

  return { step, origin: lo, offsets, weight }
}

export interface CorrectionScore {
  /** Sideways deviation before and after, in the band the ripple lives in. */
  before: number
  after: number
  /** Share of the ripple removed. Negative means the correction made it worse. */
  removed: number
}

/**
 * Score a correction on a pass it was not built from.
 *
 * The only honest test. A table fitted to a recording can always be made to flatter that
 * recording; whether it helps a pass it has never seen is the question, and the first attempt
 * at this reported a 13% improvement that turned out to be a sign error making things worse.
 */
export function scoreCorrection(
  pts: readonly RawSample[],
  c: Correction,
  bandLowPx = 80,
  bandHighPx = 14
): CorrectionScore {
  const ripple = (samples: { x: number; y: number }[]): number => {
    if (samples.length < 8) return 0
    let cx = 0
    let cy = 0
    for (const p of samples) {
      cx += p.x
      cy += p.y
    }
    cx /= samples.length
    cy /= samples.length
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const p of samples) {
      const ux = p.x - cx
      const uy = p.y - cy
      sxx += ux * ux
      syy += uy * uy
      sxy += ux * uy
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const dx = Math.cos(theta)
    const dy = Math.sin(theta)
    const err = samples.map((p) => (p.x - cx) * -dy + (p.y - cy) * dx)

    // Path length between samples, so the band windows below are in pixels rather than samples.
    let travel = 0
    for (let i = 1; i < samples.length; i++) {
      travel += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
    }
    const perSample = Math.max(1e-6, travel / Math.max(1, samples.length - 1))
    const avg = (src: number[], half: number): number[] => {
      const out = new Array<number>(src.length)
      for (let i = 0; i < src.length; i++) {
        const a = Math.max(0, i - half)
        const b = Math.min(src.length - 1, i + half)
        let m = 0
        for (let k = a; k <= b; k++) m += src[k]
        out[i] = m / (b - a + 1)
      }
      return out
    }
    const wide = avg(err, Math.max(1, Math.round(bandLowPx / perSample / 2)))
    const noLow = err.map((v, i) => v - wide[i])
    const band = avg(noLow, Math.max(1, Math.round(bandHighPx / perSample / 2)))
    let sq = 0
    for (const v of band) sq += v * v
    return Math.sqrt(sq / band.length)
  }

  const raw = pts.map((p) => ({ x: p.x, y: p.y }))
  const fixed = pts.map((p) => correct(c, p.x, p.y))
  const before = ripple(raw)
  const after = ripple(fixed)
  return { before, after, removed: before > 0 ? 1 - after / before : 0 }
}
