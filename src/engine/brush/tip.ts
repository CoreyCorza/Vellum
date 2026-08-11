import { Surface } from '../surface'
import { clamp } from '../types'

const TIP_RESOLUTION = 256
/** Ceiling sprites only hold a smooth ramp, so they can be much smaller. */
const CAP_RESOLUTION = 128

/**
 * The brush tip, pre-rendered once and blitted per dab.
 *
 * Building a radial gradient inside the dab loop is the single biggest reason
 * naive canvas painting crawls — at 3% spacing a long stroke is thousands of
 * dabs, and each gradient construction is far more expensive than the blit.
 * So: rasterise the falloff once into an alpha mask, tint a copy, and from then
 * on a dab is one `drawImage`.
 *
 * A textured/scattered tip slots in here — swap what fills `mask` and the rest
 * of the engine needs no changes.
 */
export class TipCache {
  private mask = new Surface(TIP_RESOLUTION, TIP_RESOLUTION)
  private ink = new Surface(TIP_RESOLUTION, TIP_RESOLUTION)

  private builtHardness = -1
  private builtColor = ''

  /** The tinted sprite to stamp. Rebuilds only when hardness or colour change. */
  get(hardness: number, color: string): Surface {
    if (hardness === this.builtHardness && color === this.builtColor) return this.ink
    this.build(hardness, color)
    return this.ink
  }

  /**
   * Opaque GREY sprite whose brightness is `ceiling x tipProfile`, for the
   * opacity ceiling buffer.
   *
   * It has to be opaque with the value in the colour channel, because the
   * ceiling is accumulated with `lighten` — a max on colour — and `lighten`
   * only behaves as a true max when the source is opaque. Drawing the white
   * alpha mask with a reduced globalAlpha instead would fall back to source-over
   * and creep upward with every overlapping dab.
   *
   * Carrying the SOFT profile here (rather than a hard disc) is what keeps a
   * stroke's edge soft where it crosses itself: coverage saturates in the
   * overlap and stops describing the falloff, so the mask must.
   *
   * Cached per quantised level. 64 steps is well below visible banding in
   * alpha, and the sprites are small since they only hold a smooth ramp.
   */
  capSprite(hardness: number, ceiling: number): Surface {
    this.ensureMask(hardness)
    const level = Math.max(0, Math.min(63, Math.round(clamp(ceiling, 0, 1) * 63)))
    const cached = this.capCache.get(level)
    if (cached) return cached

    const s = new Surface(CAP_RESOLUTION, CAP_RESOLUTION)
    const c = s.ctx
    c.save()
    // opaque black, then white-at-alpha(profile x ceiling) over it leaves
    // RGB = profile x ceiling with alpha 1
    c.globalCompositeOperation = 'copy'
    c.fillStyle = '#000000'
    c.fillRect(0, 0, CAP_RESOLUTION, CAP_RESOLUTION)
    c.globalCompositeOperation = 'source-over'
    c.globalAlpha = level / 63
    c.drawImage(this.mask.canvas, 0, 0, CAP_RESOLUTION, CAP_RESOLUTION)
    c.restore()

    this.capCache.set(level, s)
    return s
  }

  private capCache = new Map<number, Surface>()

  private ensureMask(hardness: number): void {
    if (hardness !== this.builtHardness) this.build(hardness, this.builtColor || '#000000')
  }

  invalidate(): void {
    this.builtHardness = -1
  }

  /**
   * Hard-edged white disc, for writing the opacity ceiling.
   *
   * Deliberately not the soft brush tip: the ceiling should be uniform across
   * the stroke's width, with all the softness coming from coverage. Using the
   * soft tip here would apply the falloff twice and thin the edges.
   */
  get hardDisc(): Surface {
    if (!this.disc) {
      this.disc = new Surface(TIP_RESOLUTION, TIP_RESOLUTION)
      const c = this.disc.ctx
      c.fillStyle = '#ffffff'
      c.beginPath()
      // a hair inside the sprite so the antialiased rim is not clipped
      c.arc(TIP_RESOLUTION / 2, TIP_RESOLUTION / 2, TIP_RESOLUTION / 2 - 1, 0, Math.PI * 2)
      c.fill()
    }
    return this.disc
  }
  private disc: Surface | null = null

  private build(hardness: number, color: string): void {
    const r = TIP_RESOLUTION / 2
    const m = this.mask.ctx
    m.clearRect(0, 0, TIP_RESOLUTION, TIP_RESOLUTION)

    // Cap below 1 so even a "hard" brush keeps a sub-pixel of antialiasing at
    // large sizes; small sizes get it free from downscaling the sprite.
    const h = clamp(hardness, 0, 0.985)
    const g = m.createRadialGradient(r, r, 0, r, r, r)
    const STOPS = 32
    for (let i = 0; i <= STOPS; i++) {
      const t = i / STOPS
      let a: number
      if (t <= h) {
        a = 1
      } else {
        const u = (t - h) / (1 - h)
        a = 1 - u * u * (3 - 2 * u) // smoothstep
      }
      g.addColorStop(t, `rgba(255,255,255,${a})`)
    }
    m.fillStyle = g
    m.fillRect(0, 0, TIP_RESOLUTION, TIP_RESOLUTION)

    const k = this.ink.ctx
    k.save()
    k.globalCompositeOperation = 'source-over'
    k.clearRect(0, 0, TIP_RESOLUTION, TIP_RESOLUTION)
    k.fillStyle = color
    k.fillRect(0, 0, TIP_RESOLUTION, TIP_RESOLUTION)
    k.globalCompositeOperation = 'destination-in'
    k.drawImage(this.mask.canvas, 0, 0)
    k.restore()

    // The ceiling sprites embed the profile, so a hardness change invalidates
    // them all.
    if (hardness !== this.builtHardness) this.capCache.clear()
    this.builtHardness = hardness
    this.builtColor = color
  }
}
