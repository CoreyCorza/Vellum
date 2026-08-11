import { Surface, type DrawSource } from './surface'
import type { PaintDocument } from './document'
import { blendToComposite } from './types'

/**
 * Flattens the layer stack into one surface for display.
 *
 * The optimisation that matters: layers BELOW the active one are cached into a
 * single prefix surface, rebuilt only when the stack changes. During a stroke
 * that turns an N-layer composite into ~3 blits regardless of N.
 *
 * Deliberately NOT cached: the layers above the active one. Blending is
 * left-associative — ((L0 ⊕ L1) ⊕ L2) — so a cached *prefix* is exactly
 * correct, while a cached *suffix* is not: pre-flattening two multiply layers
 * and then blending the result gives different pixels than blending them one at
 * a time. Above-layers are usually few, so they're drawn individually.
 */
export class Compositor {
  private below: Surface
  private out: Surface
  /** Scratch for "active layer + live stroke", needed when the active layer has
   *  opacity or a blend mode — the stroke must merge *inside* the layer first. */
  private scratch: Surface

  private cachedVersion = -1
  private cachedIndex = -1

  constructor(width: number, height: number) {
    this.below = new Surface(width, height)
    this.out = new Surface(width, height)
    this.scratch = new Surface(width, height)
  }

  invalidate(): void {
    this.cachedVersion = -1
  }

  /**
   * @param strokeBuf   live stroke accumulation, or null when idle
   * @param strokeAlpha stroke opacity, applied once at composite time (wash)
   * @param strokeOp    'source-over' to paint, 'destination-out' to erase
   */
  composite(
    doc: PaintDocument,
    strokeBuf: DrawSource | null,
    strokeAlpha: number,
    strokeOp: GlobalCompositeOperation
  ): Surface {
    const activeIndex = doc.activeIndex

    if (this.cachedVersion !== doc.structureVersion || this.cachedIndex !== activeIndex) {
      this.below.clear()
      for (let i = 0; i < activeIndex; i++) {
        const l = doc.layers[i]
        if (!l.visible || l.opacity <= 0) continue
        this.below.draw(l.surface, l.opacity, blendToComposite(l.blend))
      }
      this.cachedVersion = doc.structureVersion
      this.cachedIndex = activeIndex
    }

    this.out.copyFrom(this.below)

    const active = doc.active
    if (active.visible && active.opacity > 0) {
      if (strokeBuf) {
        this.scratch.copyFrom(active.surface)
        this.scratch.draw(strokeBuf, strokeAlpha, strokeOp)
        this.out.draw(this.scratch, active.opacity, blendToComposite(active.blend))
      } else {
        this.out.draw(active.surface, active.opacity, blendToComposite(active.blend))
      }
    }

    for (let i = activeIndex + 1; i < doc.layers.length; i++) {
      const l = doc.layers[i]
      if (!l.visible || l.opacity <= 0) continue
      this.out.draw(l.surface, l.opacity, blendToComposite(l.blend))
    }

    return this.out
  }

  /** Full flatten ignoring the active-layer fast path — used for export. */
  flatten(doc: PaintDocument): Surface {
    const s = new Surface(doc.width, doc.height)
    for (const l of doc.layers) {
      if (!l.visible || l.opacity <= 0) continue
      s.draw(l.surface, l.opacity, blendToComposite(l.blend))
    }
    return s
  }
}
