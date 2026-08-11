import { gammaCurve, LINEAR_CURVE, type Curve } from './curve'

export type SymmetryMode = 'none' | 'x' | 'y' | 'xy'

export interface BrushSettings {
  size: number
  /** 0 = fully soft falloff, 1 = hard edge */
  hardness: number
  /**
   * Ceiling on how dark one stroke can get, however much it overlaps itself.
   * Reached by solving for the per-dab alpha that converges to it — see
   * StrokeEngine.alphaFor.
   */
  opacity: number
  /** Deposition rate per dab. Low flow builds up gradually toward the ceiling. */
  flow: number
  /** dab interval as a fraction of tip diameter */
  spacing: number

  pressureToSize: boolean
  pressureToOpacity: boolean
  pressureToFlow: boolean
  /**
   * Response curves mapping pen pressure (x) to output factor (y), 0..1.
   *
   * Separate curves per dynamic, because they want different shapes: most
   * people want size to ramp gently and opacity to reach full ink sooner, and a
   * single shared exponent could never express both at once.
   */
  sizeCurve: Curve
  opacityCurve: Curve
  /**
   * Flow and opacity are now genuinely different behaviours, not two names for
   * per-dab alpha: flow accumulates, opacity clamps. Whichever is more
   * restrictive wins. See StrokeEngine.alphaFor for the derivation.
   */
  flowCurve: Curve
  /** floor on pressure-driven size, as a fraction of full size */
  minSize: number

  tiltToSize: boolean
  speedToSize: boolean

  /** 0 = raw pointer, →1 = heavy lazy-brush lag */
  stabilise: number
  /**
   * How much extra smoothing to apply when zoomed out, as an exponent on
   * 1/zoom.
   *
   * Digitiser noise is fixed in SCREEN pixels, so in document pixels it grows
   * as you zoom out — measured at 16x more baked-in error at 25% than at 400%.
   * 0 leaves the stabiliser zoom-blind (what most apps do, and why a line drawn
   * zoomed out stays visibly wobblier). 1 fully cancels the amplification.
   * Above ~1 the lag gets obvious.
   */
  stabiliseZoomComp: number
  /**
   * How much the stabiliser relaxes as the pen speeds up, 0..1.
   *
   * Krita interpolates its smoothing window between a max (slow) and a min
   * (fast) using drawing speed. Careful inking gets heavily damped against
   * tremor; a confident flick stays responsive instead of dragging behind the
   * nib. 0 disables it and gives a fixed window at all speeds.
   */
  stabiliseSpeedAdapt: number
  /**
   * How much the dab path curves between samples, 0..1.
   *
   * Separate from the stabiliser, and often mistaken for it. Even with every
   * stabiliser control at zero the engine walks a Catmull-Rom spline through
   * your samples rather than straight segments, which is what stops fast
   * strokes looking like polygons — and reads as a mild "creaminess" of its
   * own. 1 is full Catmull-Rom; 0 is the exact polyline through the raw
   * samples. Anything between blends the two.
   */
  pathSmoothness: number

  color: string
  symmetry: SymmetryMode
}

export const DEFAULT_BRUSH: BrushSettings = {
  size: 34,
  hardness: 0.55,
  opacity: 1,
  flow: 0.55,
  spacing: 0.06,
  pressureToSize: true,
  pressureToOpacity: false,
  pressureToFlow: false,
  sizeCurve: LINEAR_CURVE,
  opacityCurve: LINEAR_CURVE,
  flowCurve: LINEAR_CURVE,
  minSize: 0.08,
  tiltToSize: false,
  speedToSize: false,
  stabilise: 0.35,
  // Default OFF. Zoom-varying strength measurably reduces wobble when zoomed
  // out, but it makes the slider mean something different at every zoom level,
  // and in practice that inconsistency is worse than the wobble it fixes. The
  // stabiliser should feel identical to the hand regardless of zoom.
  stabiliseZoomComp: 0,
  stabiliseSpeedAdapt: 0.6,
  pathSmoothness: 1,
  color: '#1b1f24',
  symmetry: 'none'
}

export interface BrushPreset {
  name: string
  settings: Partial<BrushSettings>
}

export const PRESETS: BrushPreset[] = [
  {
    name: 'Ink',
    settings: {
      size: 8, hardness: 0.92, opacity: 1, flow: 1, spacing: 0.03,
      pressureToSize: true, pressureToOpacity: false, sizeCurve: gammaCurve(1.4),
      minSize: 0.05, stabilise: 0.45, speedToSize: false
    }
  },
  {
    name: 'Pencil',
    settings: {
      size: 5, hardness: 0.35, opacity: 0.75, flow: 0.35, spacing: 0.05,
      pressureToSize: true, pressureToOpacity: true,
      sizeCurve: gammaCurve(1.6), opacityCurve: gammaCurve(1.6),
      minSize: 0.25, stabilise: 0.2, speedToSize: false
    }
  },
  {
    name: 'Paint',
    settings: {
      size: 52, hardness: 0.4, opacity: 1, flow: 0.5, spacing: 0.05,
      pressureToSize: true, pressureToOpacity: false, sizeCurve: gammaCurve(0.9),
      minSize: 0.15, stabilise: 0.3, speedToSize: false
    }
  },
  {
    name: 'Airbrush',
    settings: {
      size: 120, hardness: 0, opacity: 0.9, flow: 0.06, spacing: 0.03,
      pressureToSize: false, pressureToOpacity: true, opacityCurve: gammaCurve(1.8),
      minSize: 0.1, stabilise: 0.15, speedToSize: false
    }
  }
]
