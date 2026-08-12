import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useTelemetry } from '../useEditor'
import {
  CurveSampler,
  LINEAR_CURVE,
  withPointAdded,
  withPointMoved,
  withPointRemoved,
  type Curve
} from '@engine/brush/curve'

const HEIGHT = 116
const PAD = 8
const HIT_RADIUS = 9

/**
 * Editable pressure-response curve.
 *
 * Drawn on a canvas rather than built from DOM nodes: the curve itself needs a
 * per-pixel path, and mixing that with draggable DOM handles means two
 * coordinate systems that must agree. One canvas keeps it honest.
 *
 * Interaction follows the same rule as the sliders — `touch-action: none` plus
 * pointer capture, so a pen moves a handle on contact with no drag threshold.
 */
export function CurveEditor({
  value,
  onChange,
  /** Which live telemetry value to trace on the curve, if any. */
  showLivePressure = true,
  /**
   * Shown but not editable, for a dynamic whose checkbox is off.
   *
   * The curve used to be removed from the DOM instead. That kept the panel honest
   * about what was reachable, and made the whole column jump every time a checkbox
   * was ticked — with a hole left at the bottom. A dimmed control that stays put is
   * the better trade in a panel you work in continuously.
   */
  disabled = false
}: {
  value: Curve
  onChange: (next: Curve) => void
  showLivePressure?: boolean
  disabled?: boolean
}): JSX.Element {
  const editor = useTelemetry()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const samplerRef = useRef(new CurveSampler())
  const dragRef = useRef<number | null>(null)
  const sizeRef = useRef({ w: 200, h: HEIGHT })

  const livePressure = showLivePressure ? editor.telemetry.pressure : 0

  // ------------------------------------------------------------------ drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = canvas.clientWidth || 200
      const h = HEIGHT
      sizeRef.current = { w, h }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const g = canvas.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)

      const iw = w - PAD * 2
      const ih = h - PAD * 2
      const toPx = (x: number): number => PAD + x * iw
      const toPy = (y: number): number => PAD + (1 - y) * ih

      g.fillStyle = '#2b2b2b'
      g.fillRect(PAD, PAD, iw, ih)

      // grid quarters
      g.strokeStyle = 'rgba(255,255,255,.07)'
      g.lineWidth = 1
      g.beginPath()
      for (let i = 1; i < 4; i++) {
        const gx = Math.round(toPx(i / 4)) + 0.5
        const gy = Math.round(toPy(i / 4)) + 0.5
        g.moveTo(gx, PAD)
        g.lineTo(gx, PAD + ih)
        g.moveTo(PAD, gy)
        g.lineTo(PAD + iw, gy)
      }
      g.stroke()

      // identity reference, so you can see how far you have bent things
      g.strokeStyle = 'rgba(255,255,255,.14)'
      g.setLineDash([3, 3])
      g.beginPath()
      g.moveTo(toPx(0), toPy(0))
      g.lineTo(toPx(1), toPy(1))
      g.stroke()
      g.setLineDash([])

      // the curve, sampled exactly as the brush engine samples it
      const sampler = samplerRef.current
      g.strokeStyle = '#e8e8e8'
      g.lineWidth = 1.75
      g.beginPath()
      const steps = Math.max(32, Math.round(iw))
      for (let i = 0; i <= steps; i++) {
        const x = i / steps
        const y = sampler.sample(value, x)
        const px = toPx(x)
        const py = toPy(y)
        if (i === 0) g.moveTo(px, py)
        else g.lineTo(px, py)
      }
      g.stroke()

      // live pressure readout: vertical at the input, dot at the output
      if (showLivePressure && livePressure > 0.001) {
        const lx = toPx(livePressure)
        const ly = toPy(sampler.sample(value, livePressure))
        g.strokeStyle = 'rgba(110,168,254,.5)'
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(Math.round(lx) + 0.5, PAD)
        g.lineTo(Math.round(lx) + 0.5, PAD + ih)
        g.stroke()
        g.beginPath()
        g.arc(lx, ly, 3.5, 0, Math.PI * 2)
        g.fillStyle = '#6ea8fe'
        g.fill()
      }

      // control points
      for (const p of value) {
        const px = toPx(p.x)
        const py = toPy(p.y)
        g.beginPath()
        g.arc(px, py, 4, 0, Math.PI * 2)
        g.fillStyle = '#1b1b1b'
        g.fill()
        g.strokeStyle = '#ffffff'
        g.lineWidth = 1.5
        g.stroke()
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [value, livePressure, showLivePressure])

  // -------------------------------------------------------------- interaction
  const toCurveSpace = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const r = canvas.getBoundingClientRect()
    const iw = r.width - PAD * 2
    const ih = HEIGHT - PAD * 2
    return {
      x: (e.clientX - r.left - PAD) / iw,
      y: 1 - (e.clientY - r.top - PAD) / ih
    }
  }

  const hitTest = (e: { clientX: number; clientY: number }): number => {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const r = canvas.getBoundingClientRect()
    const iw = r.width - PAD * 2
    const ih = HEIGHT - PAD * 2
    for (let i = 0; i < value.length; i++) {
      const px = r.left + PAD + value[i].x * iw
      const py = r.top + PAD + (1 - value[i].y) * ih
      if (Math.hypot(e.clientX - px, e.clientY - py) <= HIT_RADIUS) return i
    }
    return -1
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const hit = hitTest(e)

    // Right-click or middle-click removes; endpoints are protected inside
    // withPointRemoved so the curve always spans 0..1.
    if (e.button === 2 || e.button === 1) {
      if (hit >= 0) onChange(withPointRemoved(value, hit))
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    if (hit >= 0) {
      dragRef.current = hit
      return
    }
    // Adding on empty space and immediately dragging it means one gesture
    // places a point exactly where you want it.
    const p = toCurveSpace(e)
    const next = withPointAdded(value, p.x, p.y)
    onChange(next)
    dragRef.current = next.findIndex((q) => q.x === Math.min(Math.max(p.x, 0.01), 0.99))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const i = dragRef.current
    if (i === null || i < 0) return
    const p = toCurveSpace(e)
    onChange(withPointMoved(value, i, p.x, p.y))
  }

  const endDrag = (): void => {
    dragRef.current = null
  }

  return (
    <div
      className={'curve-editor' + (disabled ? ' disabled' : '')}
      title={disabled ? 'Turn the dynamic on to shape its curve' : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
        title="Drag to shape · click empty space to add a point · right-click a point to remove"
      />
      <div className="curve-foot">
        <span className="hint">soft ← pressure → hard</span>
        <button
          className="mini"
          disabled={disabled}
          title="Reset to linear"
          onClick={() => onChange(LINEAR_CURVE.map((p) => ({ ...p })))}
        >
          ⟲
        </button>
      </div>
    </div>
  )
}
