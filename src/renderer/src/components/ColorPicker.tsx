import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Slider } from './Slider'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const t: [number, number, number] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [
    Math.round((t[0] + m) * 255),
    Math.round((t[1] + m) * 255),
    Math.round((t[2] + m) * 255)
  ]
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  const v = mx
  const s = mx ? d / mx : 0
  let h = 0
  if (d) {
    if (mx === r) h = 60 * ((((g - b) / d) % 6 + 6) % 6)
    else if (mx === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return [h, s, v]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  const l = (mx + mn) / 2
  let h = 0
  let s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (mx === r) h = 60 * ((((g - b) / d) % 6 + 6) % 6)
    else if (mx === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const t: [number, number, number] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [
    Math.round((t[0] + m) * 255),
    Math.round((t[1] + m) * 255),
    Math.round((t[2] + m) * 255)
  ]
}

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`

type ColorMode = 'hsv' | 'rgb' | 'hsl'

export function ColorPicker({
  color,
  onChange,
  showTitle = true
}: {
  color: string
  onChange: (hex: string) => void
  showTitle?: boolean
}): JSX.Element {
  const svRef = useRef<HTMLCanvasElement>(null)
  const hueRef = useRef<HTMLCanvasElement>(null)
  const [hsv, setHsv] = useState<[number, number, number]>([32, 0.1, 0.91])
  const [text, setText] = useState(color)
  const [mode, setMode] = useState<ColorMode>('hsv')
  const [canvasRevision, setCanvasRevision] = useState(0)

  // Adopt colours set from elsewhere (eyedropper, swatch, preset) without
  // fighting the user's own dragging: only resync when the hex actually differs
  // from what our HSV already produces.
  useEffect(() => {
    const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2])
    if (toHex(r, g, b).toLowerCase() !== color.toLowerCase()) {
      const m = /^#?([0-9a-f]{6})$/i.exec(color)
      if (m) {
        const hexStr = m[1]
        setHsv(
          rgbToHsv(
            parseInt(hexStr.slice(0, 2), 16) / 255,
            parseInt(hexStr.slice(2, 4), 16) / 255,
            parseInt(hexStr.slice(4, 6), 16) / 255
          )
        )
      }
    }
    setText(color)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color])

  useEffect(() => {
    const sv = svRef.current
    const hue = hueRef.current
    if (!sv || !hue) return

    const observer = new ResizeObserver(() => setCanvasRevision((value) => value + 1))
    observer.observe(sv)
    observer.observe(hue)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const sv = svRef.current
    const hue = hueRef.current
    if (!sv || !hue) return
    const [h, s, v] = hsv
    const dpr = window.devicePixelRatio || 1
    const svWidth = sv.clientWidth
    const svHeight = sv.clientHeight
    const hueWidth = hue.clientWidth
    const hueHeight = hue.clientHeight

    const resizeBackingStore = (canvas: HTMLCanvasElement, width: number, height: number): void => {
      const pixelWidth = Math.max(1, Math.round(width * dpr))
      const pixelHeight = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    }
    resizeBackingStore(sv, svWidth, svHeight)
    resizeBackingStore(hue, hueWidth, hueHeight)

    const c = sv.getContext('2d')
    if (c) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.fillStyle = `hsl(${h},100%,50%)`
      c.fillRect(0, 0, svWidth, svHeight)
      let g = c.createLinearGradient(0, 0, svWidth, 0)
      g.addColorStop(0, '#fff')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = g
      c.fillRect(0, 0, svWidth, svHeight)
      g = c.createLinearGradient(0, 0, 0, svHeight)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, '#000')
      c.fillStyle = g
      c.fillRect(0, 0, svWidth, svHeight)
      const px = s * svWidth
      const py = (1 - v) * svHeight
      c.beginPath()
      c.arc(px, py, 5, 0, Math.PI * 2)
      c.strokeStyle = '#000'
      c.lineWidth = 3
      c.stroke()
      c.strokeStyle = '#fff'
      c.lineWidth = 1.5
      c.stroke()
    }

    const k = hue.getContext('2d')
    if (k) {
      k.setTransform(dpr, 0, 0, dpr, 0, 0)
      const g = k.createLinearGradient(0, 0, hueWidth, 0)
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`)
      k.fillStyle = g
      k.fillRect(0, 0, hueWidth, hueHeight)
      const hx = (h / 360) * hueWidth
      k.beginPath()
      k.rect(hx - 2, 0, 4, hueHeight)
      k.strokeStyle = '#000'
      k.lineWidth = 3
      k.stroke()
      k.strokeStyle = '#fff'
      k.lineWidth = 1.5
      k.stroke()
    }
  }, [hsv, canvasRevision])

  const emit = (next: [number, number, number]): void => {
    setHsv(next)
    const [r, g, b] = hsvToRgb(next[0], next[1], next[2])
    onChange(toHex(r, g, b))
  }

  const rgb = hsvToRgb(hsv[0], hsv[1], hsv[2])
  const hsl = rgbToHsl(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
  const emitRgb = (next: [number, number, number]): void => {
    emit(rgbToHsv(next[0] / 255, next[1] / 255, next[2] / 255))
  }
  const emitHsl = (next: [number, number, number]): void => {
    const nextRgb = hslToRgb(next[0], next[1], next[2])
    emitRgb(nextRgb)
  }

  // Same zero-threshold treatment as the sliders — touch-action:none in CSS,
  // pointer capture here, value applied on contact.
  const dragHandler =
    (fn: (x: number, y: number) => void) =>
    (e: ReactPointerEvent<HTMLCanvasElement>): void => {
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      const apply = (ev: { clientX: number; clientY: number }): void => {
        const r = el.getBoundingClientRect()
        fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1))
      }
      apply(e)
      const move = (ev: PointerEvent): void => apply(ev)
      const up = (): void => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    }

  return (
    <div className="sec">
      {showTitle && <h2>Colour</h2>}
      <canvas
        id="sv"
        ref={svRef}
        width={200}
        height={112}
        onPointerDown={dragHandler((x, y) => emit([hsv[0], x, 1 - y]))}
      />
      <canvas
        id="hue"
        ref={hueRef}
        width={200}
        height={13}
        onPointerDown={dragHandler((x) => emit([x * 360, hsv[1], hsv[2]]))}
      />
      <div className="color-mode-row">
        <label htmlFor="color-mode">Channels</label>
        <select
          id="color-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as ColorMode)}
        >
          <option value="hsv">HSV</option>
          <option value="rgb">RGB</option>
          <option value="hsl">HSL</option>
        </select>
      </div>
      <div className="color-channels">
        {mode === 'hsv' && (
          <>
            <Slider label="Hue" value={hsv[0]} min={0} max={360} step={1} defaultValue={0} format={(v) => `${Math.round(v)}\u00b0`} onChange={(v) => emit([v, hsv[1], hsv[2]])} />
            <Slider label="Saturation" value={hsv[1] * 100} min={0} max={100} step={1} defaultValue={100} format={(v) => `${Math.round(v)}%`} onChange={(v) => emit([hsv[0], v / 100, hsv[2]])} />
            <Slider label="Value" value={hsv[2] * 100} min={0} max={100} step={1} defaultValue={100} format={(v) => `${Math.round(v)}%`} onChange={(v) => emit([hsv[0], hsv[1], v / 100])} />
          </>
        )}
        {mode === 'rgb' && (
          <>
            <Slider label="Red" value={rgb[0]} min={0} max={255} step={1} defaultValue={0} format={(v) => String(Math.round(v))} onChange={(v) => emitRgb([v, rgb[1], rgb[2]])} />
            <Slider label="Green" value={rgb[1]} min={0} max={255} step={1} defaultValue={0} format={(v) => String(Math.round(v))} onChange={(v) => emitRgb([rgb[0], v, rgb[2]])} />
            <Slider label="Blue" value={rgb[2]} min={0} max={255} step={1} defaultValue={0} format={(v) => String(Math.round(v))} onChange={(v) => emitRgb([rgb[0], rgb[1], v])} />
          </>
        )}
        {mode === 'hsl' && (
          <>
            <Slider label="Hue" value={hsl[0]} min={0} max={360} step={1} defaultValue={0} format={(v) => `${Math.round(v)}\u00b0`} onChange={(v) => emitHsl([v, hsl[1], hsl[2]])} />
            <Slider label="Saturation" value={hsl[1] * 100} min={0} max={100} step={1} defaultValue={100} format={(v) => `${Math.round(v)}%`} onChange={(v) => emitHsl([hsl[0], v / 100, hsl[2]])} />
            <Slider label="Lightness" value={hsl[2] * 100} min={0} max={100} step={1} defaultValue={50} format={(v) => `${Math.round(v)}%`} onChange={(v) => emitHsl([hsl[0], hsl[1], v / 100])} />
          </>
        )}
      </div>
      <input
        id="hex"
        spellCheck={false}
        maxLength={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={() => {
          const m = /^#?([0-9a-f]{6})$/i.exec(text.trim())
          if (m) onChange(`#${m[1]}`)
          else setText(color)
        }}
      />
    </div>
  )
}
