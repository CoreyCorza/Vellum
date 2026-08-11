import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  /** >1 gives the low end more of the track. A linear 1..400px size slider
   *  crams every usable brush into the first 5%, which is why Photoshop's is
   *  miserable to set by hand. */
  gamma?: number
  step?: number
  defaultValue: number
  format: (v: number) => string
  onChange: (v: number) => void
}

/**
 * Hand-rolled instead of <input type="range">, for one reason above all:
 * `touch-action: none` plus pointer capture means the pen moves the value on
 * contact. The native control leaves gesture disambiguation to the browser,
 * which under Windows Ink withholds the drag until it has decided the contact
 * is not a scroll, a tap or a long-press. That delay is the "drag threshold"
 * that makes tablet work in browser-based tools feel broken.
 *
 * Everything else here is a bonus the native control cannot do anyway: gamma
 * mapping, shift-fine drag, wheel nudge, double-click reset, typed entry.
 */
export function Slider(props: SliderProps): JSX.Element {
  const { label, value, min, max, step, defaultValue, format, onChange } = props
  const gamma = props.gamma ?? 1
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ rect: DOMRect; startX: number; startPos: number; fine: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fine, setFine] = useState(false)
  const [editing, setEditing] = useState(false)

  const toPos = (v: number): number => Math.pow(clamp((v - min) / (max - min), 0, 1), 1 / gamma)
  const toVal = (p: number): number => {
    let v = min + (max - min) * Math.pow(clamp(p, 0, 1), gamma)
    if (step) v = Math.round(v / step) * step
    return clamp(v, min, max)
  }
  const commit = (v: number): void => onChange(clamp(v, min, max))

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    const el = trackRef.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    drag.current = { rect, startX: e.clientX, startPos: toPos(value), fine: e.shiftKey }
    setDragging(true)
    setFine(e.shiftKey)
    // No threshold: the value follows the nib the instant it lands.
    if (!e.shiftKey) commit(toVal((e.clientX - rect.left) / rect.width))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    if (e.shiftKey !== d.fine) {
      // re-anchor so toggling fine mid-drag doesn't jump
      d.fine = e.shiftKey
      d.startX = e.clientX
      d.startPos = toPos(value)
      setFine(d.fine)
    }
    commit(
      toVal(
        d.fine
          ? d.startPos + ((e.clientX - d.startX) / d.rect.width) * 0.12
          : (e.clientX - d.rect.left) / d.rect.width
      )
    )
  }

  const endDrag = (): void => {
    drag.current = null
    setDragging(false)
    setFine(false)
  }

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    commit(toVal(toPos(value) + (e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 0.004 : 0.02)))
  }

  const pos = toPos(value)

  return (
    <div
      className={`sl${dragging ? ' drag' : ''}${fine ? ' fine' : ''}`}
      tabIndex={0}
      onWheel={onWheel}
      onDoubleClick={() => commit(defaultValue)}
      onKeyDown={(e) => {
        const d = e.shiftKey ? 0.004 : 0.02
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault()
          commit(toVal(pos - d))
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault()
          commit(toVal(pos + d))
        }
      }}
      title={`${label} — drag, shift-drag for fine, wheel to nudge, double-click for default, click the number to type it`}
    >
      <div className="sl-top">
        <span className="sl-lab">{label}</span>
        {editing ? (
          <input
            className="sl-edit"
            autoFocus
            defaultValue={String(+value.toFixed(2))}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                const n = parseFloat((e.target as HTMLInputElement).value)
                if (isFinite(n)) commit(n)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={(e) => {
              const n = parseFloat(e.target.value)
              if (isFinite(n)) commit(n)
              setEditing(false)
            }}
          />
        ) : (
          <span className="sl-val" onClick={() => setEditing(true)}>
            {format(value)}
          </span>
        )}
      </div>
      <div
        className="sl-track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="sl-fill" style={{ width: `${pos * 100}%` }} />
        <div className="sl-knob" style={{ left: `${pos * 100}%` }} />
      </div>
    </div>
  )
}
