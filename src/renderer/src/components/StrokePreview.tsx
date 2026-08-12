import { useEffect, useMemo, useRef } from 'react'
import { useEditorState } from '../useEditor'
import { PresetThumbnails } from '@engine/brush/thumbnail'

/** Rendered at 2x this and scaled down, so it stays crisp on any display. */
const W = 240
const H = 52

/**
 * A live stroke of the current brush, across the top of the settings panel.
 *
 * Photoshop, Krita and Clip Studio all put one here for the same reason: once the
 * settings are grouped into categories you can only see a few at a time, so
 * something has to show the combined result. Drawn by the real engine, so it is the
 * mark rather than a picture of one.
 *
 * Painted onto a canvas rather than swapped in as an <img src>. The first version
 * produced a data URL per change — a synchronous PNG encode and a GPU readback —
 * and scrubbing brush size with Alt+RMB stuttered the whole app, because that
 * gesture changes the brush on every frame. Coalesced to one paint per frame on top
 * of that, since several settings can change in a single tick.
 */
export function StrokePreview(): JSX.Element {
  const editor = useEditorState()
  const b = editor.brush
  const erasing = editor.tool === 'eraser'
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pending = useRef(0)

  const thumbs = useMemo(() => new PresetThumbnails(W, H), [])

  // Only the settings that change the MARK. Spacing and the stabiliser are absent
  // because neither shows on a synthetic path.
  const signature = [
    b.size, b.hardness, b.opacity, b.flow, b.color, erasing,
    b.pressureToSize, b.pressureToOpacity, b.pressureToFlow, b.minSize,
    JSON.stringify(b.sizeCurve), JSON.stringify(b.opacityCurve), JSON.stringify(b.flowCurve)
  ].join('|')

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return

    cancelAnimationFrame(pending.current)
    pending.current = requestAnimationFrame(() => {
      thumbs.paintInto(ctx, cv.width, cv.height, { ...b }, erasing)
    })
    return () => cancelAnimationFrame(pending.current)
    // `b` is read inside, but the signature is what decides whether the mark moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, thumbs])

  return (
    <div className="stroke-preview">
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
    </div>
  )
}
