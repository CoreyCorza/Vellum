import type { Capture, RawSample } from './capture'
import type { AxisTable, Correction } from './correction'
import { offsetAt } from './correction'
import { fitLine, type Line } from './analysis'
import { shapeResiduals, directionSpread, type ShapeResidual } from './shapes'

/**
 * Working out a tablet's distortion from its own recordings, inside the app.
 *
 * This existed first as a command-line script, which meant a correction could only be produced by
 * someone willing to run build tools and hand over a JSON file — useless to anybody else, and
 * useless to the same person with a different tablet or six months later. Every digitiser has its
 * own error; a measurement that cannot be repeated by the person who needs it is a curiosity.
 *
 * The method, in the order the evidence arrived:
 *
 *   Sideways error against a straightedge is the only usable channel. The error also shows up as
 *   the pen hurrying and dawdling along a line, but a real arm varies its speed by around a pixel
 *   over a distortion of a third of that, and no realistic number of passes separates them.
 *
 *   Averaging the passes of one sweep removes the hand, which is not tied to position, and keeps
 *   what is — measured at 99% retention over five passes.
 *
 *   Sideways error mixes the two axes, so one angle cannot separate them. Sweeps at different
 *   angles give different mixtures of the same two unknowns, and a joint fit recovers both.
 *
 *   Each sweep gets its own smooth nuisance term, because a straightedge is not straight either
 *   and its bow is fixed to position exactly like a sensor error. Only what sweeps at different
 *   placements agree on reaches the tables.
 */

const BIN = 4
const ITERATIONS = 12
/** Step size for the alternating fit. Below one so the two axes cannot push each other apart. */
const DAMPING = 0.7
/** A bin needs this much evidence before it is trusted. */
const MIN_WEIGHT = 8

interface Profile {
  err: number[]
  x: number[]
  y: number[]
  step: number
  dx: number
  dy: number
  passes: number
  angleDeg: number
}

const dedup = (pts: readonly RawSample[]): RawSample[] => {
  const out: RawSample[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || p.x !== q.x || p.y !== q.y) out.push(p)
  }
  return out
}

const smooth = (src: readonly number[], half: number): number[] => {
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

/**
 * Put a capture's samples into a frame fixed to the screen.
 *
 * Document coordinates move with the zoom and with wherever the canvas was scrolled to, so two
 * recordings only refer to the same physical place once both are converted. Skipping this made
 * combining sessions actively harmful — three sweeps together scored worse than two.
 */
const toGlass = (c: Capture): RawSample[] => {
  const s = c.viewScale > 0 ? c.viewScale : 1
  const cx = typeof c.viewX === 'number' ? c.viewX : 0
  const cy = typeof c.viewY === 'number' ? c.viewY : 0
  return dedup(c.raw).map((p) => ({ ...p, x: (p.x - cx) * s, y: (p.y - cy) * s }))
}

/** Split a back-and-forth sweep into its individual passes, in order of position. */
function splitPasses(pts: readonly RawSample[], line: Line): { along: number[]; err: number[] }[] {
  const along: number[] = []
  const err: number[] = []
  for (const p of pts) {
    const ux = p.x - line.cx
    const uy = p.y - line.cy
    along.push(ux * line.dx + uy * line.dy)
    err.push(ux * -line.dy + uy * line.dx)
  }
  // Turns are found on a heavily smoothed copy, so the ripple cannot invent one, and only count
  // once the pen has committed to the new direction — otherwise a pause at the end of a pass reads
  // as several turns.
  const sm = smooth(along, 40)
  const span = Math.max(...sm) - Math.min(...sm)
  const commit = span * 0.15
  const cuts = [0]
  let dir = 0
  let anchor = sm[0]
  for (let i = 1; i < sm.length; i++) {
    const move = sm[i] - anchor
    if (dir === 0) {
      if (Math.abs(move) > commit) {
        dir = move > 0 ? 1 : -1
        anchor = sm[i]
      }
    } else if (move * dir < -commit) {
      cuts.push(i)
      dir = -dir
      anchor = sm[i]
    } else if (move * dir > 0) {
      anchor = sm[i]
    }
  }
  cuts.push(sm.length)

  const out: { along: number[]; err: number[] }[] = []
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]
    const b = cuts[k + 1]
    if (b - a < 150) continue
    const idx: number[] = []
    for (let i = a; i < b; i++) idx.push(i)
    const sp = Math.max(...idx.map((i) => along[i])) - Math.min(...idx.map((i) => along[i]))
    if (sp < span * 0.6) continue
    idx.sort((i, j) => along[i] - along[j])
    out.push({ along: idx.map((i) => along[i]), err: idx.map((i) => err[i]) })
  }
  return out
}

/**
 * One sweep reduced to a single profile of error against position, with the hand averaged out.
 *
 * Sampled densely on purpose. At a coarse spacing most bins fell under the minimum weight and were
 * suppressed, which silently switched off the whole x correction while the y table appeared to be
 * sharing the work.
 */
function profileOf(pts: readonly RawSample[]): Profile | null {
  if (pts.length < 300) return null
  const line = fitLine(pts)
  const passes = splitPasses(pts, line)
  if (passes.length === 0) return null

  const lo = Math.max(...passes.map((p) => p.along[0]))
  const hi = Math.min(...passes.map((p) => p.along[p.along.length - 1]))
  if (!(hi - lo > 200)) return null

  const N = 2600
  const step = (hi - lo) / (N - 1)
  const err = new Array<number>(N).fill(0)
  const xs = new Array<number>(N).fill(0)
  const ys = new Array<number>(N).fill(0)

  for (const pass of passes) {
    let j = 0
    for (let i = 0; i < N; i++) {
      const at = lo + step * i
      while (j < pass.along.length - 2 && pass.along[j + 1] < at) j++
      const a0 = pass.along[j]
      const a1 = pass.along[j + 1]
      const f = a1 > a0 ? (at - a0) / (a1 - a0) : 0
      const e = pass.err[j] + (pass.err[j + 1] - pass.err[j]) * f
      err[i] += e / passes.length
      // The position on the glass this sample sits at, recovered from the line's own frame.
      const alongAt = at
      xs[i] += (line.cx + line.dx * alongAt + -line.dy * e) / passes.length
      ys[i] += (line.cy + line.dy * alongAt + line.dx * e) / passes.length
    }
  }

  return {
    err,
    x: xs,
    y: ys,
    step,
    dx: line.dx,
    dy: line.dy,
    passes: passes.length,
    angleDeg: (Math.atan2(line.dy, line.dx) * 180) / Math.PI
  }
}

function detrend(offsets: number[], weight: number[]): number[] {
  let n = 0
  let si = 0
  let sv = 0
  let sii = 0
  let siv = 0
  for (let i = 0; i < offsets.length; i++) {
    if (weight[i] < MIN_WEIGHT) continue
    n++
    si += i
    sv += offsets[i]
    sii += i * i
    siv += i * offsets[i]
  }
  if (n < 2) return offsets
  const den = n * sii - si * si
  const slope = den !== 0 ? (n * siv - si * sv) / den : 0
  const inter = (sv - slope * si) / n
  // A constant would shift the whole drawing and a slope would stretch it. Neither was measured;
  // both are artefacts of averaging a finite number of sweeps.
  return offsets.map((v, i) => v - inter - slope * i)
}

/** Fit both axis tables plus one smooth bow per sweep, by alternating between them. */
function fitTables(profiles: readonly Profile[]): Correction {
  let xLo = Infinity
  let xHi = -Infinity
  let yLo = Infinity
  let yHi = -Infinity
  for (const p of profiles) {
    for (const v of p.x) {
      if (v < xLo) xLo = v
      if (v > xHi) xHi = v
    }
    for (const v of p.y) {
      if (v < yLo) yLo = v
      if (v > yHi) yHi = v
    }
  }
  const nx = Math.max(2, Math.ceil((xHi - xLo) / BIN) + 1)
  const ny = Math.max(2, Math.ceil((yHi - yLo) / BIN) + 1)
  const ixOf = (v: number): number => Math.min(nx - 1, Math.max(0, Math.round((v - xLo) / BIN)))
  const iyOf = (v: number): number => Math.min(ny - 1, Math.max(0, Math.round((v - yLo) / BIN)))

  let ex = new Array<number>(nx).fill(0)
  let ey = new Array<number>(ny).fill(0)
  let wx = new Array<number>(nx).fill(0)
  let wy = new Array<number>(ny).fill(0)
  const bows = profiles.map((p) => new Array<number>(p.err.length).fill(0))

  for (let it = 0; it < ITERATIONS; it++) {
    for (let s = 0; s < profiles.length; s++) {
      const p = profiles[s]
      const resid = p.err.map((e, i) => e - (-ex[ixOf(p.x[i])] * p.dy + ey[iyOf(p.y[i])] * p.dx))
      bows[s] = smooth(resid, Math.max(2, Math.round(140 / p.step / 2)))
    }
    // Weighted least squares, for the same reason as the shape fit: dividing by a small projection
    // amplifies the samples that know least and couples that noise between the two axes.
    const sx = new Array<number>(nx).fill(0)
    const dx2 = new Array<number>(nx).fill(0)
    wx = new Array<number>(nx).fill(0)
    for (let s = 0; s < profiles.length; s++) {
      const p = profiles[s]
      for (let i = 0; i < p.err.length; i++) {
        const jy = iyOf(p.y[i])
        const r = p.err[i] - bows[s][i] - (wy[jy] >= MIN_WEIGHT ? ey[jy] : 0) * p.dx
        const b = ixOf(p.x[i])
        sx[b] += -r * p.dy
        dx2[b] += p.dy * p.dy
        wx[b]++
      }
    }
    const exNew = detrend(
      sx.map((v, i) => (dx2[i] > 1e-6 && wx[i] >= MIN_WEIGHT ? v / dx2[i] : 0)),
      wx
    )
    ex = ex.map((v, i) => v + DAMPING * (exNew[i] - v))

    const sy = new Array<number>(ny).fill(0)
    const dy2 = new Array<number>(ny).fill(0)
    wy = new Array<number>(ny).fill(0)
    for (let s = 0; s < profiles.length; s++) {
      const p = profiles[s]
      for (let i = 0; i < p.err.length; i++) {
        const jx = ixOf(p.x[i])
        const r = p.err[i] - bows[s][i] + (wx[jx] >= MIN_WEIGHT ? ex[jx] : 0) * p.dy
        const b = iyOf(p.y[i])
        sy[b] += r * p.dx
        dy2[b] += p.dx * p.dx
        wy[b]++
      }
    }
    const eyNew = detrend(
      sy.map((v, i) => (dy2[i] > 1e-6 && wy[i] >= MIN_WEIGHT ? v / dy2[i] : 0)),
      wy
    )
    ey = ey.map((v, i) => v + DAMPING * (eyNew[i] - v))
  }

  const table = (step: number, origin: number, offsets: number[], weight: number[]): AxisTable => ({
    step,
    origin,
    offsets: detrend(offsets, weight),
    weight
  })
  return { x: table(BIN, xLo, ex, wx), y: table(BIN, yLo, ey, wy) }
}

/** Sideways wobble in the band the ripple lives in, before and after applying a correction. */
function score(p: Profile, c: Correction): { before: number; after: number; removed: number } {
  const band = (v: readonly number[]): number => {
    const wide = smooth(v, Math.max(2, Math.round(80 / p.step / 2)))
    const b = smooth(
      v.map((x, i) => x - wide[i]),
      Math.max(1, Math.round(14 / p.step / 2))
    )
    let sq = 0
    for (const q of b) sq += q * q
    return Math.sqrt(sq / b.length)
  }
  const fixed = p.err.map((e, i) => {
    const ox = c.x ? offsetAt(c.x, p.x[i]) : 0
    const oy = c.y ? offsetAt(c.y, p.y[i]) : 0
    // Taking ox off x and oy off y removes (-ox*dy + oy*dx) from the sideways error.
    return e - (-ox * p.dy + oy * p.dx)
  })
  const before = band(p.err)
  const after = band(fixed)
  return { before, after, removed: before > 0 ? 1 - after / before : 0 }
}

export interface CalibrationResult {
  correction: Correction | null
  /** Sweeps that were usable, and the angles they covered. */
  sweeps: number
  angles: number[]
  /** How much wobble came off sweeps that took no part in building the table. */
  heldOut: number
  /** The same on the sweeps it was built from. A large gap means it is fitting noise. */
  onFit: number
  /** Each axis table used on the wrong axis. Should not help; if it does, nothing here is real. */
  control: number
  /** Plain-language reading of whether this is worth switching on. */
  verdict: 'good' | 'partial' | 'not enough data'
  reason: string
}

/**
 * Turn a set of recorded sweeps into a correction, and say honestly whether it is any good.
 *
 * Half the sweeps build a table which is then scored on the other half, because a table always
 * flatters the recordings it came from. The control repeats the scoring with the two axes swapped:
 * if that helps too, the gain is smoothing hidden in the measurement rather than a real error being
 * cancelled, and the result should be thrown away.
 */
export function calibrate(captures: readonly Capture[]): CalibrationResult {
  const profiles: Profile[] = []
  for (const c of captures) {
    // Held-pen and hover recordings are not sweeps and never will be.
    if (c.label === 'still' || c.label === 'hover' || c.label === 'braced' || c.label === 'press') {
      continue
    }
    const p = profileOf(toGlass(c))
    if (p) profiles.push(p)
  }

  const angles = profiles.map((p) => Math.round(((p.angleDeg % 180) + 180) % 180))
  const spread = angles.length ? Math.max(...angles) - Math.min(...angles) : 0

  if (profiles.length < 4) {
    return {
      correction: null, sweeps: profiles.length, angles, heldOut: 0, onFit: 0, control: 0,
      verdict: 'not enough data',
      reason: `only ${profiles.length} usable sweeps — at least 4 are needed, and 10 or more is better`
    }
  }
  if (spread < 30) {
    return {
      correction: null, sweeps: profiles.length, angles, heldOut: 0, onFit: 0, control: 0,
      verdict: 'not enough data',
      reason: 'the sweeps are all at similar angles — sideways error is a different mixture of the two axes at every angle, so a range of them is what separates them'
    }
  }

  const evens = profiles.filter((_, i) => i % 2 === 0)
  const odds = profiles.filter((_, i) => i % 2 === 1)
  const half = fitTables(evens)
  const all = fitTables(profiles)

  const mean = (v: number[]): number => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0)
  const heldOut = mean(odds.map((p) => score(p, half).removed))
  const onFit = mean(evens.map((p) => score(p, half).removed))
  const control = mean(odds.map((p) => score(p, { x: half.y, y: half.x }).removed))

  const beatsControl = heldOut > control + 0.15
  const verdict: CalibrationResult['verdict'] =
    heldOut > 0.3 && beatsControl ? 'good' : heldOut > 0.12 && beatsControl ? 'partial' : 'not enough data'

  return {
    correction: verdict === 'not enough data' ? null : all,
    sweeps: profiles.length,
    angles,
    heldOut,
    onFit,
    control,
    verdict,
    reason:
      verdict === 'good'
        ? 'clearly better on sweeps it was not built from, and swapping the axes does not help — this is cancelling a real error'
        : verdict === 'partial'
          ? 'a real but partial improvement; more sweeps at more angles and placements would raise it'
          : beatsControl
            ? 'too little improvement to be worth applying'
            : 'no better than using the tables on the wrong axis, which means nothing real was measured'
  }
}

/**
 * Calibrate from ordinary drawn strokes — straight lines, C curves, S curves — with no ruler.
 *
 * Same joint fit as the ruler version, fed from a different measurement. Each stroke contributes a
 * smooth curve taken as what the arm intended and a set of sideways residuals from it, and every
 * sample carries its own direction of travel, which along a curve is constantly changing. That
 * changing direction is what separates the two axes, and it is why a handful of freehand curves can
 * replace a ruler placed at several careful angles.
 *
 * The hand is dealt with by weight of numbers rather than by repetition: it is not tied to position,
 * so with enough strokes crossing each part of the surface it averages away, exactly as repeated
 * passes over one ruler did.
 */
export function calibrateFromShapes(captures: readonly Capture[]): CalibrationResult {
  const groups: ShapeResidual[][] = []
  for (const c of captures) {
    if (c.label === 'still' || c.label === 'hover' || c.label === 'braced' || c.label === 'press') {
      continue
    }
    const res = shapeResiduals(toGlass(c))
    if (res.length > 200) groups.push(res)
  }

  // How much each stroke turns. A stroke that never changes direction only samples one mixture of
  // the two axes, so a set of straight lines all the same way round is worth far less than a curve.
  const spreads = groups.map(directionSpread)
  const turning = spreads.filter((v) => v > 25).length
  const allAngles: number[] = []
  for (const g of groups) {
    for (let i = 0; i < g.length; i += 40) {
      allAngles.push(Math.round(((((Math.atan2(g[i].dy, g[i].dx) * 180) / Math.PI) % 180) + 180) % 180))
    }
  }
  const coverage = allAngles.length ? Math.max(...allAngles) - Math.min(...allAngles) : 0

  if (groups.length < 6) {
    return {
      correction: null, sweeps: groups.length, angles: allAngles, heldOut: 0, onFit: 0, control: 0,
      verdict: 'not enough data',
      reason: `only ${groups.length} usable strokes — draw at least 6, and 20 is better`
    }
  }
  if (coverage < 60 && turning === 0) {
    return {
      correction: null, sweeps: groups.length, angles: allAngles, heldOut: 0, onFit: 0, control: 0,
      verdict: 'not enough data',
      reason: 'the strokes all travel in similar directions — curves that turn, or lines at different angles, are what separate the two axes'
    }
  }

  const evens = groups.filter((_, i) => i % 2 === 0)
  const odds = groups.filter((_, i) => i % 2 === 1)
  const half = fitFromSamples(evens)
  const all = fitFromSamples(groups)

  const mean = (v: number[]): number => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0)
  const heldOut = mean(odds.map((g) => scoreSamples(g, half).removed))
  const onFit = mean(evens.map((g) => scoreSamples(g, half).removed))
  const control = mean(odds.map((g) => scoreSamples(g, { x: half.y, y: half.x }).removed))

  const beatsControl = heldOut > control + 0.15
  const verdict: CalibrationResult['verdict'] =
    heldOut > 0.25 && beatsControl ? 'good' : heldOut > 0.1 && beatsControl ? 'partial' : 'not enough data'

  return {
    correction: verdict === 'not enough data' ? null : all,
    sweeps: groups.length,
    angles: allAngles,
    heldOut,
    onFit,
    control,
    verdict,
    reason:
      verdict === 'good'
        ? 'clearly better on strokes it was not built from, and swapping the axes does not help'
        : verdict === 'partial'
          ? 'a real but partial improvement; more strokes, and more curves among them, would raise it'
          : beatsControl
            ? 'too little improvement to be worth applying'
            : 'no better than using the tables on the wrong axis, so nothing real was measured'
  }
}

/** The joint fit, taking per-sample residuals with their own local direction. */
function fitFromSamples(groups: readonly ShapeResidual[][]): Correction {
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity
  for (const g of groups) {
    for (const r of g) {
      if (r.x < xLo) xLo = r.x
      if (r.x > xHi) xHi = r.x
      if (r.y < yLo) yLo = r.y
      if (r.y > yHi) yHi = r.y
    }
  }
  const nx = Math.max(2, Math.ceil((xHi - xLo) / BIN) + 1)
  const ny = Math.max(2, Math.ceil((yHi - yLo) / BIN) + 1)
  const ixOf = (v: number): number => Math.min(nx - 1, Math.max(0, Math.round((v - xLo) / BIN)))
  const iyOf = (v: number): number => Math.min(ny - 1, Math.max(0, Math.round((v - yLo) / BIN)))

  let ex = new Array<number>(nx).fill(0)
  let ey = new Array<number>(ny).fill(0)
  let wx = new Array<number>(nx).fill(0)
  let wy = new Array<number>(ny).fill(0)

  for (let it = 0; it < ITERATIONS; it++) {
    /*
     * Weighted least squares, not an average of divided residuals.
     *
     * The sideways error a sample reports is the x error times its own dy. Recovering the x error by
     * DIVIDING by dy amplifies precisely the samples that carry least information about x — a sample
     * travelling almost along x has a tiny dy and gets multiplied by four or more — and feeds that
     * amplified noise into the other axis, which feeds it back. Six rounds of that diverges, and it
     * diverges faster with more data, which is how the bug announced itself: twenty strokes scored
     * -7%, two hundred scored -236%. More evidence can never make a correct estimator worse.
     *
     * The least squares answer multiplies by dy and divides by the sum of dy squared, so a sample
     * that knows little about this axis contributes little instead of shouting.
     */
    /*
     * Two guards, both needed, both learned by watching this diverge.
     *
     * A bin holding two or three samples produces a number that is mostly noise. Used as an input to
     * the OTHER axis it poisons that axis, which poisons this one back — and the thinner the coverage
     * the more such bins there are, which is why adding strokes made things worse rather than better.
     * So a bin only speaks once it has real evidence behind it.
     *
     * And the two tables together have a genuine blind spot: a uniform stretch or skew of the
     * coordinates produces almost no sideways error on any stroke, so the data cannot pin it down.
     * The iteration is free to wander along that direction indefinitely, and it does. Removing any
     * overall shift and tilt from both tables on EVERY round keeps the estimate in the part of the
     * answer the measurements actually constrain. Doing it only at the end, as this did first, lets
     * the wandering happen and then subtracts a straight line from a mess.
     */
    const sx = new Array<number>(nx).fill(0)
    const dx2 = new Array<number>(nx).fill(0)
    wx = new Array<number>(nx).fill(0)
    for (const g of groups) {
      for (const r of g) {
        const b = ixOf(r.x)
        const jy = iyOf(r.y)
        const resid = r.err - (wy[jy] >= MIN_WEIGHT ? ey[jy] : 0) * r.dx
        sx[b] += -resid * r.dy
        dx2[b] += r.dy * r.dy
        wx[b]++
      }
    }
    const exNew = detrend(
      sx.map((v, i) => (dx2[i] > 1e-6 && wx[i] >= MIN_WEIGHT ? v / dx2[i] : 0)),
      wx
    )
    // A partial step, so a bin that swings wildly on one round cannot drag the other axis with it.
    ex = ex.map((v, i) => v + DAMPING * (exNew[i] - v))

    const sy = new Array<number>(ny).fill(0)
    const dy2 = new Array<number>(ny).fill(0)
    const wyNext = new Array<number>(ny).fill(0)
    for (const g of groups) {
      for (const r of g) {
        const b = iyOf(r.y)
        const jx = ixOf(r.x)
        const resid = r.err + (wx[jx] >= MIN_WEIGHT ? ex[jx] : 0) * r.dy
        sy[b] += resid * r.dx
        dy2[b] += r.dx * r.dx
        wyNext[b]++
      }
    }
    wy = wyNext
    const eyNew = detrend(
      sy.map((v, i) => (dy2[i] > 1e-6 && wy[i] >= MIN_WEIGHT ? v / dy2[i] : 0)),
      wy
    )
    ey = ey.map((v, i) => v + DAMPING * (eyNew[i] - v))
  }

  return {
    x: { step: BIN, origin: xLo, offsets: detrend(ex, wx), weight: wx },
    y: { step: BIN, origin: yLo, offsets: detrend(ey, wy), weight: wy }
  }
}

/** Wobble across one stroke's residuals, before and after correcting the positions. */
function scoreSamples(
  g: readonly ShapeResidual[],
  c: Correction
): { before: number; after: number; removed: number } {
  const rms = (v: number[]): number => {
    let s = 0
    for (const q of v) s += q * q
    return Math.sqrt(s / Math.max(1, v.length))
  }
  const before = g.map((r) => r.err)
  const after = g.map((r) => {
    const ox = c.x ? offsetAt(c.x, r.x) : 0
    const oy = c.y ? offsetAt(c.y, r.y) : 0
    return r.err - (-ox * r.dy + oy * r.dx)
  })
  /*
   * Both are re-levelled before comparing.
   *
   * A correction can shift or tilt a whole stroke without making it any straighter, and leaving that
   * in would credit the correction for something that is not an improvement in the line.
   */
  const level = (v: number[]): number[] => {
    let n = 0, si = 0, sv = 0, sii = 0, siv = 0
    for (let i = 0; i < v.length; i++) { n++; si += i; sv += v[i]; sii += i * i; siv += i * v[i] }
    const den = n * sii - si * si
    const slope = den !== 0 ? (n * siv - si * sv) / den : 0
    const inter = (sv - slope * si) / n
    return v.map((q, i) => q - inter - slope * i)
  }
  const b = rms(level(before))
  const a = rms(level(after))
  return { before: b, after: a, removed: b > 0 ? 1 - a / b : 0 }
}
