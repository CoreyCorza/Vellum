import type { Surface } from '../surface'
import { Bounds } from '../bounds'
import { TipCache } from './tip'
import { StrokeRecorder } from '../diag/capture'
import type { DabTarget } from '../gl/strokeRenderer'
import { CurveSampler } from './curve'
import type { BrushSettings } from './settings'
import type { StrokePoint } from '../types'
import { clamp, lerp } from '../types'

/** Cap on retained raw samples. The Gaussian cutoff normally terminates the
 *  walk long before this; it only bounds the worst case. */
const MAX_HISTORY = 256

/** Catmull-Rom, evaluated on the b→c span. */
function catmullRom(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
}

/**
 * Smallest radius a dab is actually rasterised at, in document pixels.
 *
 * Anything smaller fades instead of shrinking — see `subPixelFade`. Half a
 * pixel, so a size-1 brush at full pressure sits exactly on the floor.
 */
const MIN_DAB_RADIUS = 0.5

/**
 * Turns a trickle of input samples into evenly-deposited dabs.
 *
 * Three things happen in here, in order:
 *   1. stabilise  — the emitted point chases the raw pointer instead of snapping
 *   2. spline     — Catmull-Rom through the stabilised points, so fast strokes
 *                   curve rather than showing the polygon
 *   3. space      — walk the spline by ARC LENGTH, dropping a dab every
 *                   `spacing × diameter`, with the interval recomputed per dab
 *                   from the current radius so a tapering stroke stays even
 *
 * Skipping (3) and drawing a dab per input sample is the classic mistake: dab
 * density then tracks how fast you moved, so fast strokes go transparent and
 * slow ones go muddy.
 */
export class StrokeEngine {
  private tips = new TipCache()
  // One sampler per dynamic; each caches its own LUT keyed on curve identity.
  private sizeCurve = new CurveSampler()
  private opacityCurve = new CurveSampler()
  private flowCurve = new CurveSampler()
  private points: StrokePoint[] = []
  private segment = 0
  /** Leftover arc length carried across spline segments. */
  private carry = 0

  private sx = 0
  private sy = 0
  private sp = 0
  private lastT = 0
  private speed = 0
  /** Previous RAW sample, to measure how far the pen actually travelled. */
  private lastRawX = 0
  private lastRawY = 0
  /** Raw samples with their step distances, for the Gaussian distance window. */
  private history: (StrokePoint & { d: number })[] = []
  /** Last three raw pressures, for impulse rejection. */
  private pRecent: number[] = []
  /** Count of single-sample pressure spikes rejected this stroke. */
  spikesRejected = 0
  /** Camera zoom at stroke start, for the zoom-compensated smoothing length. */
  private viewScale = 1

  /**
   * Every raw sample, kept so a stroke can be replayed through a different filter later.
   * Always on: a profiler you have to arm misses the stroke that went wrong.
   */
  readonly recorder = new StrokeRecorder()

  readonly bounds = new Bounds()
  active = false
  erasing = false

  /** Where dabs land — the WebGL2 stroke renderer. */
  private target: DabTarget | null = null
  private docWidth = 0
  private docHeight = 0

  constructor(private settings: () => BrushSettings) {}

  invalidateTip(): void {
    this.tips.invalidate()
  }

  /** Stabilised samples for the in-flight stroke. Diagnostics only. */
  get stabilisedPoints(): readonly StrokePoint[] {
    return this.points
  }

  /** The current tip sprite, for UI that wants to show the real brush. */
  previewSprite(): Surface {
    const s = this.settings()
    return this.tips.get(s.hardness, s.color)
  }

  begin(
    target: DabTarget,
    p: StrokePoint,
    erasing: boolean,
    docW: number,
    docH: number,
    viewScale = 1
  ): void {
    this.viewScale = Math.max(1e-3, viewScale)
    this.active = true
    this.erasing = erasing
    this.target = target
    this.docWidth = docW
    this.docHeight = docH
    this.points.length = 0
    this.segment = 0
    this.carry = 0
    this.speed = 0
    this.lastT = p.t
    this.sx = p.x
    this.sy = p.y
    this.sp = p.pressure
    this.bounds.reset()
    this.spikesRejected = 0
    this.recorder.begin(p, this.viewScale, 0, 0)
    this.pushStabilised(p, true)
  }

  /** Feed one sample. Call once per coalesced event — do not pre-filter. */
  extend(p: StrokePoint): void {
    if (!this.active) return
    const dt = Math.max(1, p.t - this.lastT)
    this.lastT = p.t
    const prev = this.points[this.points.length - 1]
    if (prev) {
      const inst = (Math.hypot(p.x - prev.x, p.y - prev.y) / dt) * 16
      this.speed = lerp(this.speed, inst, 0.35)
    }
    this.recorder.extend(p)
    this.pushStabilised(p, false)
    this.pump(false)
  }

  /** Flush the tail and stop. Returns the touched rect (may be empty). */
  end(): void {
    if (!this.active) return
    this.pump(true)
    if (this.points.length === 1) {
      const q = this.points[0]
      this.stamp(q.x, q.y, q.pressure, q.tilt) // a tap is a single dab
    }
    this.recorder.end(this.points)
    this.active = false
    this.target = null
    this.points.length = 0
  }

  cancel(): void {
    this.active = false
    this.target = null
    this.points.length = 0
    this.bounds.reset()
  }

  // ---------------------------------------------------------------- internals

  /**
   * Smoothing window in DOCUMENT pixels, before the /3 that turns it into sigma.
   *
   * Expressed as a SCREEN distance first and then converted, so the slider
   * means the same thing at every zoom — the hand works in screen space, and a
   * stabiliser whose strength drifts with zoom feels broken even when it is
   * measurably reducing more noise. This matches Krita's default
   * (`useScalableDistance`, which divides its distance by the zoom).
   *
   * `speedNorm` (0..1) relaxes the window as the pen accelerates, the way
   * Krita interpolates between smoothnessDistanceMax and Min.
   */
  private smoothingWindowDoc(speedNorm: number): number {
    const s = this.settings()
    const st = clamp(s.stabilise, 0, 0.98)
    if (st <= 0) return 0
    const maxScreen = 6 * (st / (1 - st))
    const adapt = clamp(s.stabiliseSpeedAdapt ?? 0, 0, 1)
    const minScreen = maxScreen * (1 - adapt)
    const windowScreen = (1 - speedNorm) * maxScreen + speedNorm * minScreen
    const scale = this.viewScale
    // Opt-in only; see stabiliseZoomComp. Clamped so it can never *reduce*
    // smoothing when zoomed in.
    const zoomBoost = Math.max(1, Math.pow(1 / scale, s.stabiliseZoomComp ?? 0))
    return (windowScreen / scale) * zoomBoost
  }

  /**
   * Pen speed as 0..1, in SCREEN px/ms so it does not drift with zoom.
   *
   * `this.speed` is kept in document px per 16 ms frame, hence the /16. Getting
   * this conversion wrong pinned speedNorm at 1, so the stabiliser ran
   * permanently in "fast flick" mode and barely smoothed anything.
   */
  private speedNorm(): number {
    const FAST = 2.0 // screen px/ms — about 2000 px/s, a committed flick
    const screenPxPerMs = (this.speed * this.viewScale) / 16
    return clamp(screenPxPerMs / FAST, 0, 1)
  }

  /*
   * REMOVED: the "jitter floor" soft-threshold.
   *
   * It was built to suppress what looked like sensor wobble, which turned out
   * to be our own coordinate quantisation (see SUBPIXEL in main/wintab.ts). Two
   * things were wrong with it beyond being unnecessary:
   *
   *  - It thresholded the difference between the raw and smoothed points, but
   *    the noise is already inside the smoothed value, so it could never remove
   *    wobble — only decide how much raw noise to add back.
   *  - It derived a direction of travel from the last two points. At low speed
   *    those points nearly coincide, so the direction became noise and the
   *    threshold flung the output sideways at random — visible as blobby,
   *    jittering segments at the slow ends of a stroke, i.e. it *caused*
   *    jitter.
   *
   * Kept as a note because the underlying idea (amplitude discriminates noise
   * from intent) is sound; it just needs a stable reference path to threshold
   * against, which a causal filter cannot provide.
   */

  /**
   * Three-tap median on pressure — impulse rejection.
   *
   * A single stray sample reading far above its neighbours produces one dab at
   * hugely elevated alpha, which shows up as an isolated dark dot along an
   * otherwise even stroke. It is invisible when pressure drives SIZE instead,
   * because one oversized dab among ~17 overlapping neighbours barely changes
   * their union — so the same bad sample only becomes visible through opacity.
   *
   * A median is the right tool rather than an average: it discards a lone
   * outlier completely while leaving genuine pressure ramps untouched, and it
   * costs one sample of delay (5ms at 200Hz).
   */
  private despikePressure(pressure: number): number {
    const r = this.pRecent
    r.push(pressure)
    if (r.length > 3) r.shift()
    if (r.length < 3) return pressure
    const [a, b, c] = r
    const median = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
    // the value we act on is the middle sample, now vetted by its neighbours
    if (Math.abs(b - median) > 0.02) this.spikesRejected++
    return median
  }

  private pushStabilised(rawPoint: StrokePoint, first: boolean): void {
    const p: StrokePoint =
      first ? rawPoint : { ...rawPoint, pressure: this.despikePressure(rawPoint.pressure) }
    if (first) {
      this.pRecent.length = 0
      this.pRecent.push(p.pressure)
      this.sx = p.x
      this.sy = p.y
      this.sp = p.pressure
      this.lastRawX = p.x
      this.lastRawY = p.y
      this.history.length = 0
      this.history.push({ ...p, d: 0 })
    } else {
      const step = Math.hypot(p.x - this.lastRawX, p.y - this.lastRawY)
      this.lastRawX = p.x
      this.lastRawY = p.y
      this.history.push({ ...p, d: step })
      if (this.history.length > MAX_HISTORY) this.history.shift()

      /*
       * Gaussian-weighted average over a DISTANCE window, walking backwards
       * through the raw history — the shape Krita uses.
       *
       * The previous implementation was a one-pole exponential average
       * (`s += (raw - s) * k`). That is the worst-behaved low-pass available:
       * its impulse response has an infinite exponential tail, so it pays lag
       * for attenuation it never really delivers. A Gaussian FIR of the same
       * lag attenuates far more, which is most of why Krita's strokes feel
       * clean without feeling dragged.
       *
       * Weighting by accumulated DISTANCE rather than sample count also makes
       * the filter independent of pen speed and report rate — a 200 Hz tablet
       * and a 133 Hz one now behave identically, and drawing slowly no longer
       * smooths more than drawing fast merely because more samples arrived.
       */
      const sigma = this.smoothingWindowDoc(this.speedNorm()) / 3
      if (sigma <= 1e-6 || this.history.length <= 3) {
        this.sx = p.x
        this.sy = p.y
        this.sp = p.pressure
      } else {
        const twoSigmaSq = 2 * sigma * sigma
        let distanceSum = 0
        let scaleSum = 0
        let ax = 0
        let ay = 0
        let ap = 0
        let peak = 0
        for (let i = this.history.length - 1; i >= 0; i--) {
          const h = this.history[i]
          // h.d is the distance from the PREVIOUS sample, so add it only once
          // we have stepped past the newest point.
          if (i < this.history.length - 1) distanceSum += this.history[i + 1].d
          const rate = Math.exp(-(distanceSum * distanceSum) / twoSigmaSq)
          if (peak === 0) peak = rate
          // Krita's cutoff: stop once a sample contributes under 1% of peak.
          else if (rate * 100 < peak) break
          scaleSum += rate
          ax += rate * h.x
          ay += rate * h.y
          ap += rate * h.pressure
        }
        if (scaleSum > 0) {
          this.sx = ax / scaleSum
          this.sy = ay / scaleSum
          this.sp = ap / scaleSum
        }
      }
    }
    const last = this.points[this.points.length - 1]
    if (!first && last && Math.hypot(this.sx - last.x, this.sy - last.y) < 0.05) return
    this.points.push({
      x: this.sx,
      y: this.sy,
      pressure: this.sp,
      tilt: p.tilt,
      twist: p.twist,
      t: p.t
    })
  }

  private pump(final: boolean): void {
    const P = this.points
    while (this.segment + 1 < P.length) {
      const i = this.segment
      // a spline span needs one neighbour on each side; without the trailing
      // one we wait, unless this is the final flush
      if (i + 2 >= P.length && !final) break
      this.emit(P[i - 1] ?? P[i], P[i], P[i + 1], P[i + 2] ?? P[i + 1])
      this.segment++
    }
  }

  private emit(p0: StrokePoint, p1: StrokePoint, p2: StrokePoint, p3: StrokePoint): void {
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const steps = clamp(Math.ceil(chord / 1.5), 2, 160)

    let px = p1.x
    let py = p1.y
    let pp = p1.pressure
    let pt = p1.tilt

    // Blend between the spline and straight-line interpolation. Catmull-Rom is
    // a cardinal spline, so easing its influence toward the chord is a smooth,
    // monotonic dial rather than an on/off switch — at 0 the path is exactly
    // the polyline through the samples.
    const curve = clamp(this.settings().pathSmoothness ?? 1, 0, 1)

    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      let x: number
      let y: number
      if (curve >= 1) {
        x = catmullRom(p0.x, p1.x, p2.x, p3.x, t)
        y = catmullRom(p0.y, p1.y, p2.y, p3.y, t)
      } else {
        const lx = p1.x + (p2.x - p1.x) * t
        const ly = p1.y + (p2.y - p1.y) * t
        x = curve <= 0 ? lx : lx + (catmullRom(p0.x, p1.x, p2.x, p3.x, t) - lx) * curve
        y = curve <= 0 ? ly : ly + (catmullRom(p0.y, p1.y, p2.y, p3.y, t) - ly) * curve
      }
      const pr = lerp(p1.pressure, p2.pressure, t)
      const ti = lerp(p1.tilt, p2.tilt, t)

      const segLen = Math.hypot(x - px, y - py)
      if (segLen > 1e-6) {
        let used = 0
        for (;;) {
          const f0 = used / segLen
          const interval = Math.max(
            0.55,
            this.radiusFor(lerp(pp, pr, f0), lerp(pt, ti, f0)) * 2 * this.settings().spacing
          )
          if (this.carry + (segLen - used) < interval) break
          // carry can exceed the interval when pressure drops mid-span; clamping
          // the advance to >= 0 stops the walk running backwards forever
          used += Math.max(0, interval - this.carry)
          const f = used / segLen
          this.stamp(px + (x - px) * f, py + (y - py) * f, lerp(pp, pr, f), lerp(pt, ti, f))
          this.carry = 0
        }
        this.carry += segLen - used
      }

      px = x
      py = y
      pp = pr
      pt = ti
    }
  }

  /** The radius the settings ask for, before the sub-pixel floor. */
  private wantedRadius(pressure: number, tilt: number): number {
    const s = this.settings()
    let f = 1
    if (s.pressureToSize) {
      f = s.minSize + (1 - s.minSize) * this.sizeCurve.sample(s.sizeCurve, pressure)
    }
    if (s.tiltToSize) f *= lerp(1, 0.45, clamp(tilt, 0, 1))
    if (s.speedToSize) f *= clamp(1 - this.speed * 0.0022, 0.35, 1)
    return Math.max(0, s.size * 0.5 * f)
  }

  private radiusFor(pressure: number, tilt: number): number {
    return Math.max(MIN_DAB_RADIUS, this.wantedRadius(pressure, tilt))
  }

  /**
   * Alpha compensation for a dab whose radius hit the floor.
   *
   * A dab thinner than a pixel cannot get thinner — there is no geometry left
   * to remove. Clamping the radius and stopping there is why a light touch drew
   * a solid one-pixel line and pressure felt dead at small sizes. So the
   * footprint holds at the floor and alpha takes the difference instead, scaled
   * by AREA, which deposits roughly the ink the smaller dab would have. A light
   * touch comes out as a faint hairline, and faint is what the eye reads as
   * thinner.
   *
   * This is the thing `minSize` was really working around: without it you had
   * to hold the brush off the floor to keep the taper, which is a workaround
   * for the engine rather than a style choice.
   */
  private subPixelFade(pressure: number, tilt: number): number {
    const wanted = this.wantedRadius(pressure, tilt)
    if (wanted >= MIN_DAB_RADIUS) return 1
    const ratio = wanted / MIN_DAB_RADIUS
    return ratio * ratio
  }

  /**
   * Per-dab alpha — FLOW only.
   *
   * Flow is a deposition rate, so dabs accumulate: coverage in the stroke
   * buffer converges toward 1 the more the stroke passes over a spot.
   *
   * Opacity is deliberately NOT applied here. It is a *ceiling*, and a ceiling
   * cannot be expressed as a per-dab multiply: at flow 1 the buffer saturates
   * to 1 whatever multiplier you used, which is exactly why "pressure →
   * opacity" used to behave like flow. Nor can it be faked by solving for the
   * alpha that converges to the target — that only lands correctly for the
   * expected overlap count, so scribbling back over a filled area sails past
   * it. The ceiling lives in a separate per-pixel buffer; see `capFor` and
   * Editor.endStroke.
   */
  private alphaFor(pressure: number): number {
    const s = this.settings()
    let flow = s.flow
    if (s.pressureToFlow) flow *= this.flowCurve.sample(s.flowCurve, pressure)
    return clamp(flow, 0, 1)
  }

  /** The opacity ceiling this dab imposes, 0..1. */
  private capFor(pressure: number): number {
    const s = this.settings()
    let ceiling = s.opacity
    if (s.pressureToOpacity) ceiling *= this.opacityCurve.sample(s.opacityCurve, pressure)
    return clamp(ceiling, 0, 1)
  }

  /** Places a dab plus its symmetry mirrors. */
  private stamp(x: number, y: number, pressure: number, tilt: number): void {
    const s = this.settings()
    const mode = s.symmetry
    this.dab(x, y, pressure, tilt)
    if (mode === 'none') return
    const cx = this.docWidth / 2
    const cy = this.docHeight / 2
    if (mode === 'x' || mode === 'xy') this.dab(2 * cx - x, y, pressure, tilt)
    if (mode === 'y' || mode === 'xy') this.dab(x, 2 * cy - y, pressure, tilt)
    if (mode === 'xy') this.dab(2 * cx - x, 2 * cy - y, pressure, tilt)
  }

  private dab(x: number, y: number, pressure: number, tilt: number): void {
    const target = this.target
    if (!target) return
    const s = this.settings()
    const r = this.radiusFor(pressure, tilt)
    const a = this.alphaFor(pressure)
    if (a <= 0.001) return

    // One call, one draw. The renderer needs the ceiling as well as the flow
    // because the blend is conditional on it — see gl/strokeRenderer.ts. The
    // eraser stamps identically; whether the result is added or subtracted is
    // decided once, at commit, by the composite op.
    target.stampDab(x, y, r, a * this.subPixelFade(pressure, tilt), this.capFor(pressure), s.hardness)

    this.bounds.add(x, y, r + 1)
  }
}
