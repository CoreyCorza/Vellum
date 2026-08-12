import { useMemo } from 'react'
import { useEditorState } from '../useEditor'
import { PresetThumbnails } from '@engine/brush/thumbnail'

/**
 * A live stroke of the current brush, across the top of the settings panel.
 *
 * Photoshop, Krita and Clip Studio all put one here, and for the same reason: once
 * the settings are grouped into categories you can only see a few at a time, so
 * something has to show the combined result. Drawn by the real engine, so it is the
 * mark rather than a picture of one.
 *
 * Re-rendered only when a setting that changes the mark changes — the signature
 * below is the dependency. Colour is in it because the stroke is drawn in it;
 * spacing and the stabiliser are not, because neither shows on a synthetic path.
 */
export function StrokePreview(): JSX.Element {
  const editor = useEditorState()
  const b = editor.brush
  const erasing = editor.tool === 'eraser'

  // Rendered at a fixed size and stretched to the panel's width. Resizing a WebGL
  // target on every drag of the panel edge would cost far more than the blur saves.
  const thumbs = useMemo(() => new PresetThumbnails(220, 52), [])

  const signature = [
    b.size, b.hardness, b.opacity, b.flow, b.color, erasing,
    b.pressureToSize, b.pressureToOpacity, b.pressureToFlow, b.minSize,
    JSON.stringify(b.sizeCurve), JSON.stringify(b.opacityCurve), JSON.stringify(b.flowCurve)
  ].join('|')

  const src = useMemo(() => thumbs.live({ ...b }, erasing), [signature, thumbs])

  return (
    <div className="stroke-preview">
      <img src={src} alt="" draggable={false} />
    </div>
  )
}
