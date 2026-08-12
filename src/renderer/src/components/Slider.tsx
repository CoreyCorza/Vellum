import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

/** How far the pointer may move on the number before it counts as a drag. */
const EDIT_SLOP = 3

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
 * A slider that IS its own row: the bar carries the label and the value inside it,
 * and the fill shows the position.
 *
 * The label and value used to sit on a line above a thin track, which cost about
 * fourteen pixels per control — over a hundred and forty across the settings panel,
 * for information that fits inside the bar perfectly well.
 *
 * Hand-rolled rather than <input type="range">, for one reason above all:
 * `touch-action: none` plus pointer capture means the pen moves the value on
 * contact. The native control leaves gesture disambiguation to the browser, which
 * under Windows Ink withholds the drag until it has decided the contact is not a
 * scroll, a tap or a long-press. That delay is the "drag threshold" that makes
 * tablet work in browser-based tools feel broken.
 *
 * Everything else here is a bonus the native control cannot do anyway: gamma
 * mapping, shift-fine drag, wheel nudge, double-click reset, typed entry.
 */
export function Slider(props: SliderProps): JSX.Element {
  const { label, value, min, max, step, defaultValue, format, onChange } = props
  const gamma = props.gamma ?? 1
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ rect: DOMRect; startX: number; startPos: number; fine: boolean } | null>(null)
  /** Set when the press landed on the number: a press that does not move there
   *  means "let me type it" rather than "set it to roughly here". */
  const pendingEdit = useRef(false)
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
    if (editing) return
    e.preventDefault()
    const el = trackRef.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    drag.current = { rect, startX: e.clientX, startPos: toPos(value), fine: e.shiftKey }
    setDragging(true)
    setFine(e.shiftKey)

    // The number is a text field as well as part of the bar. Landing on it holds
    // the value still until the pointer proves it meant to scrub, so there is no
    // dead zone at the right-hand end and no jump when you only wanted to type.
    pendingEdit.current = (e.target as HTMLElement)?.dataset?.slval === '1'
    if (pendingEdit.current) return

    // No threshold anywhere else: the value follows the nib the instant it lands.
    if (!e.shiftKey) commit(toVal((e.clientX - rect.left) / rect.width))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    if (pendingEdit.current) {
      if (Math.abs(e.clientX - d.startX) < EDIT_SLOP) return
      pendingEdit.current = false
    }
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
    if (pendingEdit.current) {
      pendingEdit.current = false
      setEditing(true)
    }
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
      ref={trackRef}
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-valuenow={+value.toFixed(2)}
      aria-valuemin={min}
      aria-valuemax={max}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
      <div className="sl-fill" style={{ width: `${pos * 100}%` }} />
      <span className="sl-lab">{label}</span>
      {editing ? (
        <input
          className="sl-edit"
          autoFocus
          defaultValue={String(+value.toFixed(2))}
          // Selected on focus, so typing replaces the value rather than appending
          // to it. Nobody opens this to add a digit to what is already there.
          onFocus={(e) => e.currentTarget.select()}
          onPointerDown={(e) => e.stopPropagation()}
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
        <span className="sl-val" data-slval="1">
          {format(value)}
        </span>
      )}
    </div>
  )
}
