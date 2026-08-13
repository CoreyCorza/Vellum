import type { Capture, RawSample } from './capture'
import type { AxisTable, Correction } from './correction'
import { offsetAt } from './correction'
import { fitLine, type Line } from './analysis'

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
const ITERATIONS = 6
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
    const sx = new Array<number>(nx).fill(0)
    wx = new Array<number>(nx).fill(0)
    for (let s = 0; s < profiles.length; s++) {
      const p = profiles[s]
      // A sweep nearly parallel to an axis says almost nothing about that axis, and dividing by a
      // vanishing projection amplifies whatever noise it does carry.
      if (Math.abs(p.dy) < 0.2) continue
      for (let i = 0; i < p.err.length; i++) {
        const r = p.err[i] - bows[s][i] - ey[iyOf(p.y[i])] * p.dx
        const b = ixOf(p.x[i])
        sx[b] += -r / p.dy
        wx[b]++
      }
    }
    ex = sx.map((v, i) => (wx[i] > 0 ? v / wx[i] : 0))

    const sy = new Array<number>(ny).fill(0)
    wy = new Array<number>(ny).fill(0)
    for (let s = 0; s < profiles.length; s++) {
      const p = profiles[s]
      if (Math.abs(p.dx) < 0.2) continue
      for (let i = 0; i < p.err.length; i++) {
        const r = p.err[i] - bows[s][i] + ex[ixOf(p.x[i])] * p.dy
        const b = iyOf(p.y[i])
        sy[b] += r / p.dx
        wy[b]++
      }
    }
    ey = sy.map((v, i) => (wy[i] > 0 ? v / wy[i] : 0))
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
