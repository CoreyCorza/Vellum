import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { toPos, toVal, type ScrubRange } from './scrubMath'

/**
 * A tall, wordless slider for the quick rail.
 *
 * Deliberately not the panel Slider turned on its side. That one is a labelled row
 * in a settings list; this is a control you reach for mid-stroke without looking,
 * so it has no permanent text at all — the value appears beside the thumb only
 * while you are dragging it, and the name lives in the tooltip.
 *
 * Fills from the BOTTOM, because a bigger brush reading as a taller bar is the only
 * mapping that needs no thought.
 */
export function RailSlider({
  label,
  value,
  range,
  format,
  onChange,
  onScrubStart,
  onScrubEnd
}: {
  label: string
  value: number
  range: ScrubRange
  format: (v: number) => string
  onChange: (v: number) => void
  /** For controls whose value is hard to picture — see Editor.showBrushPreview. */
  onScrubStart?: () => void
  onScrubEnd?: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ rect: DOMRect; startY: number; startPos: number; fine: boolean } | null>(
    null
  )
  const [dragging, setDragging] = useState(false)
  /** The track's screen box, captured on press. The readout is portalled to the
   *  document body — the rail is barely wider than the slider, and the panel clips
   *  its contents, so a readout laid out inside it would be cut off. */
  const [box, setBox] = useState<DOMRect | null>(null)

  const pos = toPos(value, range)
  const commit = (p: number): void => onChange(toVal(p, range))

  /** Bottom of the track is 0, top is 1. */
  const fromY = (clientY: number, rect: DOMRect): number => 1 - (clientY - rect.top) / rect.height

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    const el = ref.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    drag.current = { rect, startY: e.clientY, startPos: pos, fine: e.shiftKey }
    setBox(rect)
    setDragging(true)
    onScrubStart?.()
    // No threshold: the value follows the nib the instant it lands, same as the
    // panel sliders. Shift starts a fine drag from where the value already is.
    if (!e.shiftKey) commit(fromY(e.clientY, rect))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    if (e.shiftKey !== d.fine) {
      d.fine = e.shiftKey
      d.startY = e.clientY
      d.startPos = pos
    }
    commit(
      d.fine
        ? d.startPos - ((e.clientY - d.startY) / d.rect.height) * 0.12
        : fromY(e.clientY, d.rect)
    )
  }

  const end = (): void => {
    drag.current = null
    setDragging(false)
    setBox(null)
    onScrubEnd?.()
  }

  return (
    <div
      className={`railsl${dragging ? ' drag' : ''}`}
      ref={ref}
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={+value.toFixed(2)}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      title={`${label} — drag, shift-drag for fine, wheel to nudge`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onWheel={(e: WheelEvent<HTMLDivElement>) =>
        commit(pos + (e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 0.004 : 0.02))
      }
      onKeyDown={(e) => {
        const d = e.shiftKey ? 0.004 : 0.02
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault()
          commit(pos - d)
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault()
          commit(pos + d)
        }
      }}
    >
      <div className="railsl-fill" style={{ height: `${pos * 100}%` }} />
      {/* Inset by half its own height at each end. Left on a plain percentage the
          thumb hangs half outside the track at min and max, and since the track is
          what receives the press, clicking the visible thumb there did nothing. */}
      <div className="railsl-thumb" style={{ bottom: `calc(5px + ${pos} * (100% - 10px))` }} />
      {dragging &&
        box &&
        createPortal(
          <div
            className="railsl-readout"
            style={{
              right: Math.round(window.innerWidth - box.left + 8),
              bottom: Math.round(window.innerHeight - (box.bottom - pos * box.height) - 9)
            }}
          >
            {format(value)}
          </div>,
          document.body
        )}
    </div>
  )
}
