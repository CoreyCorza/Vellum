import { Surface } from '../surface'
import { clamp } from '../types'

const TIP_RESOLUTION = 256
/**
 * The brush tip as a sprite, for the on-canvas brush cursor.
 *
 * NOT what gets painted: dabs are rasterised analytically in the fragment
 * shader (see gl/strokeRenderer.ts), because a fixed-resolution sprite cannot
 * give a clean rim at every brush size. This exists only so the cursor can show
 * roughly the right shape, which is why a sprite is still good enough here.
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
  invalidate(): void {
    this.builtHardness = -1
    this.builtColor = ''
  }

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

    this.builtHardness = hardness
    this.builtColor = color
  }
}
