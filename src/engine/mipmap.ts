/**
 * A halving pyramid over a source canvas, for drawing it smaller than 1:1.
 *
 * Canvas 2D's `drawImage` does ONE bilinear tap however far you shrink, so at
 * 25% it samples one source pixel in sixteen and throws the other fifteen away.
 * Thin lines blink in and out as you pan, texture turns to moiré, and the image
 * reads as a noisy sample of itself rather than a small version of it.
 *
 * Halving repeatedly averages every pixel exactly once per level, so nothing is
 * discarded. The caller then draws from the level nearest the target scale,
 * where the remaining shrink is at most 2x and bilinear is actually adequate.
 *
 * The zoomed-out viewport and a navigator thumbnail are the same problem, so
 * they share this: `levelFor` takes any scale and returns the right level.
 *
 * Levels are built lazily, only as deep as the requested scale needs, and reused
 * until `invalidate()`. There is no engine-external API here — this is plain
 * Canvas 2D, so it runs in the verification scripts like everything else.
 */
export class MipPyramid {
  /** `levels[i]` is the source at 1 / 2^(i + 1). The source itself is level -1. */
  private levels: HTMLCanvasElement[] = []
  private srcW = 0
  private srcH = 0

  /** Drop every level. Call whenever the source pixels change. */
  invalidate(): void {
    this.levels.length = 0
  }

  /**
   * The level to draw from for `scale`, plus its dimensions.
   *
   * Returns the source unchanged for scale >= 0.5, where one bilinear tap is
   * already fine. Below that, picks the level whose own scale is the first at or
   * above `scale`, leaving at most a 2x shrink for the caller's drawImage.
   */
  levelFor(
    source: HTMLCanvasElement,
    scale: number
  ): { canvas: HTMLCanvasElement; width: number; height: number } {
    if (source.width !== this.srcW || source.height !== this.srcH) {
      this.srcW = source.width
      this.srcH = source.height
      this.levels.length = 0
    }
    if (!(scale > 0) || scale >= 0.5 || source.width < 2 || source.height < 2) {
      return { canvas: source, width: source.width, height: source.height }
    }

    // scale 0.49..0.25 -> level 0 (half), 0.24..0.125 -> level 1 (quarter), ...
    const want = Math.min(
      Math.floor(Math.log2(1 / scale)) - 1,
      // stop before a level would round to nothing
      Math.floor(Math.log2(Math.max(1, Math.min(source.width, source.height)))) - 1
    )
    if (want < 0) return { canvas: source, width: source.width, height: source.height }

    for (let i = this.levels.length; i <= want; i++) {
      const prev = i === 0 ? source : this.levels[i - 1]
      const w = Math.max(1, prev.width >> 1)
      const h = Math.max(1, prev.height >> 1)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      if (!g) return { canvas: source, width: source.width, height: source.height }
      // Exactly 2:1, so this bilinear tap is a clean 4-pixel box average.
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, w, h)
      this.levels[i] = c
    }

    const lvl = this.levels[want]
    return { canvas: lvl, width: lvl.width, height: lvl.height }
  }
}
