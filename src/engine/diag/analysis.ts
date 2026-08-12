import type { RawSample } from './capture'

/**
 * Measuring what a tablet actually does, rather than how a stroke looks.
 *
 * Everything here is arithmetic on recorded samples: no DOM, no GL, no app state, so it
 * runs the same in the app, in a verification script, and over a file captured last week.
 *
 * The central trick is that a ruler gives us something this problem almost never has — a
 * known intended shape. Against a straightedge the pen was meant to travel in a straight
 * line, so the distance from each sample to the best-fit line through the stroke is
 * error, and error is a signal that can be measured instead of admired.
 */

export interface Line {
  /** A point on the line: the centroid of the samples. */
  cx: number
  cy: number
  /** Unit vector along the line, pointing the way the pen travelled. */
  dx: number
  dy: number
}

/**
 * The line the stroke was trying to be.
 *
 * Fitted by principal axis rather than by least squares on y against x. Least squares
 * assumes the error is all in y, so it tilts toward horizontal and cannot describe a
 * vertical line at all — and vertical ruler strokes are half the test set. The principal
 * axis minimises distance to the line itself, which is the quantity we are about to
 * measure, and it has no preferred orientation.
 */
export function fitLine(pts: readonly { x: number; y: number; t?: number }[]): Line {
  const n = pts.length
  if (n === 0) return { cx: 0, cy: 0, dx: 1, dy: 0 }
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= n
  cy /= n

  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of pts) {
    const ux = p.x - cx
    const uy = p.y - cy
    sxx += ux * ux
    syy += uy * uy
    sxy += ux * uy
  }

  // Major axis of the covariance. atan2 keeps this stable when the spread is purely
  // vertical (sxx - syy negative, sxy zero), where a slope would be infinite.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  let dx = Math.cos(theta)
  let dy = Math.sin(theta)

  // The axis has no inherent direction, so point it the way the pen went. Without this,
  // "distance along the stroke" can run backwards and every plot against it is mirrored.
  let forward = 0
  for (let i = 1; i < n; i++) {
    forward += (pts[i].x - pts[i - 1].x) * dx + (pts[i].y - pts[i - 1].y) * dy
  }
  if (forward < 0) {
    dx = -dx
    dy = -dy
  }

  return { cx, cy, dx, dy }
}

export interface Deviation {
  line: Line
  /** Distance along the intended line, per sample. */
  along: number[]
  /** Signed distance from the line. Positive is left of travel. This is the wobble. */
  error: number[]
  /** ms, relative to the first sample. */
  t: number[]
  /** Distance actually travelled through the samples, cumulative. */
  travelled: number[]
  /**
   * Speed in px per ms, measured across a window rather than between neighbours.
   *
   * Step-to-step speed is unusable here: at a slow crawl the pen advances less per sample
   * than the noise moves it sideways, so the noisiest samples read as the fastest ones and
   * any grouping by speed comes out scrambled. Measuring displacement across several
   * samples averages the sideways jitter out and leaves the actual progress.
   */
  speed: number[]
}

/** Split a stroke into distance along the intended line and error away from it. */
export function deviation(pts: readonly RawSample[], line = fitLine(pts)): Deviation {
  const along: number[] = []
  const error: number[] = []
  const t: number[] = []
  const travelled: number[] = []
  const speed: number[] = []
  const t0 = pts.length ? pts[0].t : 0
  let run = 0

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const ux = p.x - line.cx
    const uy = p.y - line.cy
    along.push(ux * line.dx + uy * line.dy)
    // Perpendicular to the direction of travel, so a positive error is a consistent
    // side of the line rather than a consistent screen direction.
    error.push(ux * -line.dy + uy * line.dx)
    t.push(p.t - t0)
    if (i > 0) run += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)
    travelled.push(run)
  }

  const half = 4
  for (let i = 0; i < pts.length; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(pts.length - 1, i + half)
    const dt = pts[b].t - pts[a].t
    speed.push(dt > 0 ? Math.hypot(pts[b].x - pts[a].x, pts[b].y - pts[a].y) / dt : 0)
  }

  return { line, along, error, t, travelled, speed }
}

export interface Spread {
  count: number
  mean: number
  sd: number
  rms: number
  /** Largest absolute value. What you notice on a single bad wobble. */
  peak: number
  /** 95th percentile of absolute values. What you notice generally. */
  p95: number
  /** Full swing from the most negative to the most positive. */
  peakToPeak: number
}

export function spread(v: readonly number[]): Spread {
  const n = v.length
  if (n === 0) {
    return { count: 0, mean: 0, sd: 0, rms: 0, peak: 0, p95: 0, peakToPeak: 0 }
  }
  let sum = 0
  let sumSq = 0
  let lo = Infinity
  let hi = -Infinity
  for (const x of v) {
    sum += x
    sumSq += x * x
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  const mean = sum / n
  const abs = v.map(Math.abs).sort((a, b) => a - b)
  return {
    count: n,
    mean,
    sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    rms: Math.sqrt(sumSq / n),
    peak: abs[n - 1],
    p95: abs[Math.min(n - 1, Math.floor(0.95 * (n - 1)))],
    peakToPeak: hi - lo
  }
}

export interface Timing {
  count: number
  durationMs: number
  rateHz: number
  meanIntervalMs: number
  sdIntervalMs: number
  maxIntervalMs: number
  /** Samples that arrived with no time since the last one. */
  zeroIntervals: number
  /** Samples at exactly the position of the previous one. */
  repeatedPositions: number
  /**
   * Smallest non-zero step seen in x or y. Reveals the coordinate grid: a value of 1
   * means whole pixels and no more, and anything well below that means the samples carry
   * real sub-pixel detail worth filtering rather than a staircase to smooth away.
   */
  finestStep: number
}

export function timing(pts: readonly RawSample[]): Timing {
  const n = pts.length
  if (n < 2) {
    return {
      count: n, durationMs: 0, rateHz: 0, meanIntervalMs: 0, sdIntervalMs: 0,
      maxIntervalMs: 0, zeroIntervals: 0, repeatedPositions: 0, finestStep: 0
    }
  }
  const gaps: number[] = []
  let zero = 0
  let repeats = 0
  let finest = Infinity
  for (let i = 1; i < n; i++) {
    const dt = pts[i].t - pts[i - 1].t
    gaps.push(dt)
    if (dt <= 0) zero++
    const dx = Math.abs(pts[i].x - pts[i - 1].x)
    const dy = Math.abs(pts[i].y - pts[i - 1].y)
    if (dx === 0 && dy === 0) repeats++
    if (dx > 1e-9 && dx < finest) finest = dx
    if (dy > 1e-9 && dy < finest) finest = dy
  }
  const g = spread(gaps)
  const duration = pts[n - 1].t - pts[0].t
  return {
    count: n,
    durationMs: duration,
    rateHz: duration > 0 ? ((n - 1) / duration) * 1000 : 0,
    meanIntervalMs: g.mean,
    sdIntervalMs: g.sd,
    maxIntervalMs: Math.max(...gaps),
    zeroIntervals: zero,
    repeatedPositions: repeats,
    finestStep: finest === Infinity ? 0 : finest
  }
}

export interface Noise {
  count: number
  sdX: number
  sdY: number
  /** Radial distance from the mean position, root mean square. */
  rms: number
  peakToPeakX: number
  peakToPeakY: number
  /** How many distinct positions the pen was reported at while not moving. */
  distinctPositions: number
}

/**
 * The noise floor, from a pen held still.
 *
 * The most valuable single test, because it is the only one with no hand in it. A ruler
 * stroke measures the tablet and the arm together and cannot separate them; a pen resting
 * against a stop is measuring the digitiser alone. Everything a filter could possibly
 * remove is in this number, and everything below it is the floor no filter can beat
 * without also removing real movement.
 */
export function stationaryNoise(pts: readonly RawSample[]): Noise {
  const n = pts.length
  if (n === 0) {
    return { count: 0, sdX: 0, sdY: 0, rms: 0, peakToPeakX: 0, peakToPeakY: 0, distinctPositions: 0 }
  }
  const xs = spread(pts.map((p) => p.x))
  const ys = spread(pts.map((p) => p.y))
  let sumSq = 0
  const seen = new Set<string>()
  for (const p of pts) {
    const dx = p.x - xs.mean
    const dy = p.y - ys.mean
    sumSq += dx * dx + dy * dy
    seen.add(p.x + ',' + p.y)
  }
  return {
    count: n,
    sdX: xs.sd,
    sdY: ys.sd,
    rms: Math.sqrt(sumSq / n),
    peakToPeakX: xs.peakToPeak,
    peakToPeakY: ys.peakToPeak,
    distinctPositions: seen.size
  }
}

export interface PressureStats {
  min: number
  max: number
  /**
   * How many distinct levels the pen reports. Derived from the smallest step actually
   * seen, so it reports what arrived rather than what the box claims.
   */
  levels: number
  /** Typical change between neighbouring samples. */
  stepRms: number
  /** Largest single jump. A big one next to a small typical is a spike, not a push. */
  stepPeak: number
  /**
   * Jitter while the pen was pressed but not moving.
   *
   * The pressure equivalent of the position noise floor, and it needs the same care: a
   * measurement taken while pressing harder is measuring the press. Only samples where the
   * pen was barely moving count, and only where pressure was not trending.
   */
  jitterWhileStill: number
  /** Reversals per second: how often the pressure changed direction. Chatter. */
  reversalsPerSecond: number
}

/**
 * What the pressure channel is doing.
 *
 * Position gets all the attention because a wobbly line is visible, but pressure drives
 * size and opacity on nearly every brush, so jitter there shows up as a stroke that
 * breathes. And there is a lot of room for it to hide: 16384 levels is far finer than any
 * hand can hold steady, so every tremor in your grip is faithfully recorded and turned
 * into a width change.
 */
export function pressureStats(pts: readonly RawSample[]): PressureStats {
  const n = pts.length
  if (n < 3) {
    return {
      min: 0, max: 0, levels: 0, stepRms: 0, stepPeak: 0,
      jitterWhileStill: 0, reversalsPerSecond: 0
    }
  }

  const steps: number[] = []
  let finest = Infinity
  let reversals = 0
  let lastDir = 0
  for (let i = 1; i < n; i++) {
    const d = pts[i].pressure - pts[i - 1].pressure
    steps.push(d)
    const a = Math.abs(d)
    if (a > 1e-9 && a < finest) finest = a
    const dir = d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0
    if (dir !== 0) {
      if (lastDir !== 0 && dir !== lastDir) reversals++
      lastDir = dir
    }
  }

  // Jitter measured only where the pen was holding still, so a deliberate press is not
  // counted as noise. Detrended over a short window for the same reason.
  const held: number[] = []
  const win = 8
  for (let i = win; i < n - win; i++) {
    const moved = Math.hypot(pts[i + win].x - pts[i - win].x, pts[i + win].y - pts[i - win].y)
    if (moved > 1) continue
    let mean = 0
    for (let k = i - win; k <= i + win; k++) mean += pts[k].pressure
    mean /= win * 2 + 1
    held.push(pts[i].pressure - mean)
  }

  const ps = pts.map((p) => p.pressure)
  const duration = Math.max(1, pts[n - 1].t - pts[0].t)
  const st = spread(steps)
  return {
    min: Math.min(...ps),
    max: Math.max(...ps),
    levels: finest === Infinity ? 0 : Math.round(1 / finest),
    stepRms: st.rms,
    stepPeak: st.peak,
    jitterWhileStill: spread(held).sd,
    reversalsPerSecond: (reversals / duration) * 1000
  }
}

/**
 * Drop the unsettled ends of a held-pen recording.
 *
 * Holding a pen perfectly still needs a rig, and getting the pen into and out of the rig
 * is movement that has nothing to do with the tablet. Left in, those few samples set the
 * peak-to-peak figure for the whole recording — real data showed a 2.13 px worst swing
 * around a 0.08 px standard deviation, which is entirely the fumble.
 *
 * Rather than trimming a fixed fraction, this finds the longest calm stretch: the run of
 * samples that stays within a few times the typical step of its own middle.
 */
export function trimToSettled(pts: readonly RawSample[]): RawSample[] {
  const n = pts.length
  if (n < 40) return [...pts]

  const steps: number[] = []
  for (let i = 1; i < n; i++) {
    steps.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  }
  const sorted = [...steps].sort((a, b) => a - b)
  const typical = sorted[Math.floor(sorted.length * 0.75)] || 0
  // A generous allowance, since the point is only to cut the obvious lunges.
  const allowed = Math.max(0.5, typical * 6)

  let bestFrom = 0
  let bestLen = 0
  let from = 0
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] > allowed) {
      if (i - from > bestLen) {
        bestLen = i - from
        bestFrom = from
      }
      from = i + 1
    }
  }
  if (steps.length - from > bestLen) {
    bestLen = steps.length - from
    bestFrom = from
  }
  return bestLen < 20 ? [...pts] : pts.slice(bestFrom, bestFrom + bestLen + 1)
}

export interface Peak {
  /** Cycles per unit of whatever the positions were: Hz for seconds, 1/px for pixels. */
  frequency: number
  /** The same thing the other way up, which is usually easier to picture. */
  period: number
  /** Size of the wobble this component accounts for, in the units of the values. */
  amplitude: number
  /**
   * How far the peak stands above the typical bin. A real periodic component stands well
   * clear of the rest. Pure random noise measured about 9 during validation, and a clean
   * sinusoid measured billions, so anything under roughly 15 is broadband and a filter
   * aimed at a specific frequency would be filtering nothing.
   */
  prominence: number
  /**
   * Whether there were enough samples per cycle for this to mean anything.
   *
   * A wobble faster than about three samples per cycle cannot be measured, and worse, it
   * comes back as a confident wrong answer at some slower frequency. Validation caught
   * exactly this: a 3px wobble sampled every 3.75px reported a 15px period. When this is
   * false the number is an artefact of the sampling, not a property of the tablet.
   */
  wellSampled: boolean
}

export interface Spectrum {
  peak: Peak | null
  bins: { frequency: number; power: number }[]
  /** Samples used after resampling onto an even grid. */
  n: number
}

/**
 * Where the wobble sits, as a spectrum.
 *
 * Fed either against time or against distance travelled, and the answer to which of
 * those shows a peak matters more than the peak itself. A wobble fixed in time is the
 * electronics or the driver, and it stays at the same frequency however fast you draw. A
 * wobble fixed in distance is the sensor grid, and its apparent frequency doubles when
 * you draw twice as fast. Those want completely different treatment, and telling them
 * apart needs the same stroke measured both ways.
 *
 * Samples arrive unevenly in both domains, so they are resampled onto an even grid first.
 * A plain discrete transform is used: the recordings are a couple of thousand samples and
 * this runs in milliseconds, where a fast transform would need power-of-two padding and
 * the windowing care that goes with it.
 */
export function spectrum(
  values: readonly number[],
  positions: readonly number[],
  gridSize = 512
): Spectrum {
  const n = Math.min(gridSize, values.length)
  if (n < 8) return { peak: null, bins: [], n: 0 }

  const first = positions[0]
  const last = positions[positions.length - 1]
  const span = last - first
  if (!(span > 0)) return { peak: null, bins: [], n: 0 }

  // Even grid, linearly interpolated. Uneven spacing smears a single frequency across
  // neighbouring bins and can invent peaks that are really just the sampling.
  const h = span / (n - 1)
  const grid = new Float64Array(n)
  let j = 0
  for (let i = 0; i < n; i++) {
    const at = first + i * h
    while (j < positions.length - 2 && positions[j + 1] < at) j++
    const p0 = positions[j]
    const p1 = positions[j + 1]
    const f = p1 > p0 ? (at - p0) / (p1 - p0) : 0
    grid[i] = values[j] + (values[j + 1] - values[j]) * f
  }

  // Remove any straight-line trend. A residual tilt is a very low frequency component
  // that would otherwise dominate every spectrum and hide what we are looking for.
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sx += i
    sy += grid[i]
    sxx += i * i
    sxy += i * grid[i]
  }
  const denom = n * sxx - sx * sx
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0
  const intercept = (sy - slope * sx) / n
  for (let i = 0; i < n; i++) grid[i] -= intercept + slope * i

  // Hann window, so a frequency that does not fit a whole number of times into the
  // recording does not leak across the whole spectrum.
  let winSum = 0
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    grid[i] *= w
    winSum += w
  }

  const bins: { frequency: number; power: number }[] = []
  const half = Math.floor(n / 2)
  for (let k = 1; k < half; k++) {
    let re = 0
    let im = 0
    const w = (-2 * Math.PI * k) / n
    for (let i = 0; i < n; i++) {
      re += grid[i] * Math.cos(w * i)
      im += grid[i] * Math.sin(w * i)
    }
    bins.push({ frequency: k / (n * h), power: re * re + im * im })
  }
  if (bins.length === 0) return { peak: null, bins: [], n }

  /*
   * Only consider components that repeat at least three times in the recording.
   *
   * Otherwise the answer to "does this repeat" comes back as "yes, every 1360 px" on a
   * 1360 px line, which is a single slow drift being described as a cycle. Real data
   * produced exactly that, with a prominence high enough to look convincing. Detrending
   * removes a straight tilt but not a gentle bow, and a bow is not a pattern.
   */
  const firstUsable = 3
  if (bins.length <= firstUsable) return { peak: null, bins, n }
  let best = bins[firstUsable]
  for (let k = firstUsable; k < bins.length; k++) {
    if (bins[k].power > best.power) best = bins[k]
  }
  const powers = bins.map((b) => b.power).sort((a, b) => a - b)
  const median = powers[Math.floor(powers.length / 2)] || 1e-30

  // Two halves of the window's coherent gain: one for splitting a real sinusoid between
  // the positive and negative frequency, one for the window's own attenuation.
  const amplitude = (2 * Math.sqrt(best.power)) / winSum
  const period = best.frequency > 0 ? 1 / best.frequency : 0

  return {
    peak: {
      frequency: best.frequency,
      period,
      amplitude,
      prominence: best.power / median,
      wellSampled: period / h >= 3
    },
    bins,
    n
  }
}

export interface SpeedBand {
  label: string
  /** px per ms. */
  fromSpeed: number
  toSpeed: number
  samples: number
  rmsError: number
}

/**
 * Error split by how fast the pen was moving.
 *
 * This decides whether smoothing should vary with speed. A fixed amount of sensor error
 * matters enormously during a slow deliberate line, where it is large next to the
 * movement it is corrupting, and disappears into a fast sweep. If the bands come out
 * flat, a constant filter is the honest choice and speed adaptation is complication for
 * its own sake.
 */
export function errorBySpeed(d: Deviation, bands = 4): SpeedBand[] {
  const speeds = d.speed.filter((s) => s > 0)
  if (speeds.length < bands * 4) return []
  const sorted = [...speeds].sort((a, b) => a - b)
  const edges: number[] = [0]
  for (let i = 1; i < bands; i++) {
    edges.push(sorted[Math.floor((i / bands) * (sorted.length - 1))])
  }
  edges.push(Infinity)

  const out: SpeedBand[] = []
  for (let b = 0; b < bands; b++) {
    const picked: number[] = []
    for (let i = 0; i < d.error.length; i++) {
      if (d.speed[i] >= edges[b] && d.speed[i] < edges[b + 1]) picked.push(d.error[i])
    }
    const s = spread(picked)
    out.push({
      label: b === 0 ? 'slowest quarter' : b === bands - 1 ? 'fastest quarter' : `band ${b + 1}`,
      fromSpeed: edges[b],
      toSpeed: edges[b + 1],
      samples: s.count,
      rmsError: s.rms
    })
  }
  return out
}

export interface Report {
  label: string
  source: string
  samples: number
  timing: Timing
  /** Straightness of the stroke against its own best-fit line. */
  error: Spread
  /** Same measurement on what the app actually drew, so the stabiliser can be scored. */
  drawnError: Spread | null
  inTime: Peak | null
  inDistance: Peak | null
  bySpeed: SpeedBand[]
  /** Set when the pen was held still, i.e. this is a noise floor rather than a line. */
  noise: Noise | null
  /** How the recording was read, since the two readings mean entirely different things. */
  treatedAs: 'held pen' | 'drawn line'
  pressure: PressureStats
  /** Samples dropped from the ends of a held recording as unsettled. */
  trimmed: number
}

/** Everything worth knowing about one recorded stroke. */
export function report(
  capture: {
    label: string
    source: string
    raw: RawSample[]
    drawn: RawSample[]
    /** Camera zoom when recorded. Absent is treated as 1. */
    viewScale?: number
  },
  options: { stationary?: boolean } = {}
): Report {
  /*
   * Everything below is in SCREEN pixels, not document pixels.
   *
   * The samples arrive in document space, which means a recording made zoomed out reports
   * a larger wobble than the same hand movement made at 100% — the same tablet would score
   * differently depending on the canvas. A digitiser's error is a property of the glass, so
   * it is measured where the pen is: multiplying by the zoom puts it back on the screen.
   * Caught by drawing a stroke of known size and getting an answer 2.6x too big.
   */
  const scale = capture.viewScale && capture.viewScale > 0 ? capture.viewScale : 1
  const toScreen = (pts: RawSample[]): RawSample[] =>
    scale === 1 ? pts : pts.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale }))

  const all = toScreen(capture.raw)
  const drawnPts = toScreen(capture.drawn)
  /*
   * Was the pen held still, or drawn along something?
   *
   * Not answerable from how far it moved: a held pen jitters, and adding up those steps
   * reaches hundreds of pixels without going anywhere. Not reliably answerable from how
   * far it GOT either, because that threshold has to be in pixels and the right number
   * depends on how noisy the tablet is.
   *
   * What actually separates them is shape. A held pen leaves a roughly round blob, a few
   * times as long as it is wide. A stroke leaves a sliver, hundreds of times longer than
   * it is wide. The ratio says which, at any noise level, and the cap stops a very short
   * scribble from being mistaken for a held pen.
   *
   * A caller that knows which test it ran says so and skips the guess entirely.
   */
  const first = deviation(all)
  const alongSpan = spread(first.along).peakToPeak
  const acrossSpan = spread(first.error).peakToPeak
  const stationary = options.stationary ?? (alongSpan < 8 * acrossSpan && alongSpan < 40)

  // Only a held recording gets trimmed: on a drawn line every sample is signal, and the
  // largest steps are the fast middle rather than a fumble.
  const raw = stationary ? trimToSettled(all) : all
  const d = stationary ? deviation(raw) : first
  const t = timing(raw)

  const inTime = spectrum(d.error, d.t.map((ms) => ms / 1000)).peak
  /*
   * Distance means nothing for a held pen. Its travel is jitter, so resampling the error
   * against it produces a staircase and a spectrum of that staircase — which real data
   * reported as a 6 px pattern with a prominence in the hundred millions.
   */
  const inDistance = stationary ? null : spectrum(d.error, d.travelled).peak

  return {
    label: capture.label,
    source: capture.source,
    samples: raw.length,
    timing: t,
    error: spread(d.error),
    drawnError: drawnPts.length > 2 ? spread(deviation(drawnPts, d.line).error) : null,
    inTime,
    inDistance,
    bySpeed: stationary ? [] : errorBySpeed(d),
    noise: stationary ? stationaryNoise(raw) : null,
    treatedAs: stationary ? 'held pen' : 'drawn line',
    pressure: pressureStats(raw),
    trimmed: all.length - raw.length
  }
}
