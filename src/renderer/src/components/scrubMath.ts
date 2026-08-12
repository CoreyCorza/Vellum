export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

export interface ScrubRange {
  min: number
  max: number
  /** >1 gives the low end more of the track. A linear 1..400px size range crams
   *  every usable brush into the first 5%. */
  gamma?: number
  step?: number
}

/**
 * The value-to-position curve, shared by every scrubbable control.
 *
 * Kept in one place so the horizontal sliders in the panels and the vertical ones
 * in the quick rail cannot drift apart: the same brush size has to land at the same
 * fraction of the track in both, or dragging one and glancing at the other looks
 * like a bug.
 */
export function toPos(v: number, r: ScrubRange): number {
  return Math.pow(clamp((v - r.min) / (r.max - r.min), 0, 1), 1 / (r.gamma ?? 1))
}

export function toVal(p: number, r: ScrubRange): number {
  let v = r.min + (r.max - r.min) * Math.pow(clamp(p, 0, 1), r.gamma ?? 1)
  if (r.step) v = Math.round(v / r.step) * r.step
  return clamp(v, r.min, r.max)
}
