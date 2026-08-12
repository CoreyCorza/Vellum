import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '../useEditor'
import { report, type Report } from '@engine/diag/analysis'
import type { StrokePoint } from '@engine/types'

/**
 * Profiler mode: the whole screen, nothing on it, and a hairline trail.
 *
 * The panels have to go because the test is a line across the full width of the display
 * and a floating panel in the way makes that impossible. The brush has to go too, for a
 * less obvious reason: a tapered pressure-sensitive stroke hides the very thing being
 * measured, since a line that changes width cannot be judged for straightness by eye. A
 * one pixel trail shows the samples as they arrived, so what you see and what gets
 * measured are the same thing.
 *
 * The trail fades rather than persisting, so a run of ten tests does not end up as a
 * scribble, and the fade is slow enough to see the whole line while drawing it.
 */

interface Test {
  id: string
  label: string
  how: string
  /** Whether the pen touches the glass. Hover tests never start a stroke. */
  contact: boolean
  /** Held-pen tests are measured as a noise floor, not as a line. */
  held?: boolean
}

const TESTS: Test[] = [
  {
    id: 'still',
    label: 'Pen held still',
    how: 'Wedge the pen so it cannot move — a roll of tape works — and let it rest for ten seconds. This is the tablet on its own, with no hand in it.',
    contact: true,
    held: true
  },
  {
    id: 'hover',
    label: 'Hover, hand held up',
    how: 'Hold the pen just above the glass without touching, arm unsupported, as still as you can for ten seconds. Tablet noise plus your unbraced tremor.',
    contact: false,
    held: true
  },
  {
    id: 'braced',
    label: 'Hover, hand braced',
    how: 'Same again, but rest your hand on the screen the way you do when drawing. This is the tremor that actually reaches your lines.',
    contact: false,
    held: true
  },
  { id: 'h-slow', label: 'Horizontal, slow', how: 'Ruler across the screen, edge to edge. One slow pass, about five seconds.', contact: true },
  { id: 'h-fast', label: 'Horizontal, fast', how: 'Same ruler, one quick pass.', contact: true },
  { id: 'v-slow', label: 'Vertical, slow', how: 'Ruler upright. One slow pass, top to bottom.', contact: true },
  { id: 'v-fast', label: 'Vertical, fast', how: 'Same, one quick pass.', contact: true },
  { id: 'd-slow', label: 'Diagonal, slow', how: 'Ruler at roughly 45 degrees. One slow pass.', contact: true },
  { id: 'd-fast', label: 'Diagonal, fast', how: 'Same, one quick pass.', contact: true },
  {
    id: 'press',
    label: 'Pressure ramp',
    how: 'Press down slowly from nothing to as hard as you comfortably can, without moving the pen. Then ease off just as slowly.',
    contact: true,
    held: true
  },
  { id: 'free', label: 'Anything else', how: 'Whatever you want to measure.', contact: true }
]

/** Long enough to watch a whole slow pass appear, short enough not to accumulate. */
const FADE_PER_SECOND = 0.55

export function ProfilerStage({ onClose }: { onClose: () => void }): JSX.Element {
  const editor = useEditorState()
  const [test, setTest] = useState<Test>(TESTS[0])
  const [shown, setShown] = useState<Report | null>(null)
  const [live, setLive] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const trail = useRef<{ x: number; y: number }[]>([])
  const lastFade = useRef(0)

  // Take over the pen for as long as this is open, and put it back on the way out even if
  // that happens through an unmount rather than the button.
  useEffect(() => {
    editor.profiling = true
    editor.recorder.label = test.id
    return () => {
      editor.profiling = false
      editor.onProfileSample = null
    }
  }, [editor, test.id])

  useEffect(() => {
    editor.onProfileSample = (p: StrokePoint, phase): void => {
      if (phase === 'down') trail.current = []
      const c = editor.camera.docToScreen(p.x, p.y)
      trail.current.push({ x: c.x, y: c.y })
      if (trail.current.length > 20000) trail.current.shift()
      setLive(editor.recorder.currentSampleCount)
    }
    return () => {
      editor.onProfileSample = null
    }
  }, [editor])

  // Hover tests never touch the glass, so no stroke ever begins and nothing above sees
  // them. Read them straight off the stage instead.
  useEffect(() => {
    if (test.contact) return
    // On window, not on the stage: the stage deliberately does not take pointer events, so
    // that contact tests reach the editor underneath it.
    let recording = false
    const move = (e: PointerEvent): void => {
      if (!recording) return
      const p: StrokePoint = {
        x: e.clientX, y: e.clientY, pressure: 0, tilt: 0, twist: 0, t: e.timeStamp
      }
      editor.recorder.extend(p)
      trail.current.push({ x: e.clientX, y: e.clientY })
      setLive(editor.recorder.currentSampleCount)
    }
    const start = (): void => {
      if (recording) return
      recording = true
      trail.current = []
      editor.recorder.begin(
        { x: 0, y: 0, pressure: 0, tilt: 0, twist: 0, t: performance.now() },
        1
      )
    }
    const stop = (): void => {
      if (!recording) return
      recording = false
      editor.recorder.end([])
      setLive(0)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      e.preventDefault()
      if (recording) stop()
      else start()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('keydown', key)
      stop()
    }
  }, [editor, test])

  // The trail, faded a little each frame.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    let raf = 0
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(cv.clientWidth * dpr)
      const h = Math.round(cv.clientHeight * dpr)
      if (cv.width !== w || cv.height !== h) {
        cv.width = w
        cv.height = h
      }
      const ctx = cv.getContext('2d')
      if (!ctx) return

      const dt = lastFade.current ? Math.min(0.1, (now - lastFade.current) / 1000) : 0
      lastFade.current = now
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0,0,0,${FADE_PER_SECOND * dt})`
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'

      const pts = trail.current
      if (pts.length > 1) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        // A hairline, drawn with no smoothing and no width change, so the only thing on
        // screen is where the samples actually were.
        ctx.lineWidth = 1 / dpr
        ctx.strokeStyle = '#5ad1ff'
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const captures = editor.recorder.all()

  return (
    <div className="pstage">
      <canvas ref={canvasRef} className="pstage-canvas" />

      <div className="pstage-ui">
        <div className="pstage-head">
          <span className="pstage-title">Tablet Profiler</span>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="pstage-tests">
          {TESTS.map((t) => (
            <button
              key={t.id}
              className="pstage-test"
              aria-selected={t.id === test.id}
              onClick={() => {
                setTest(t)
                setShown(null)
                editor.recorder.label = t.id
                trail.current = []
              }}
            >
              {t.label}
              {captures.some((c) => c.label === t.id) && <span className="cat-dot" />}
            </button>
          ))}
        </div>

        <p className="pstage-how">{test.how}</p>
        {!test.contact && (
          <p className="pstage-how pstage-key">
            Press <kbd>space</kbd> to start and stop recording, since the pen never touches
            the glass.
          </p>
        )}
        {live > 0 && <p className="pstage-live">recording — {live} samples</p>}

        <div className="pstage-list">
          {captures.map((c, i) => (
            <button
              key={i}
              className="prof-row"
              onClick={() => {
                const t = TESTS.find((x) => x.id === c.label)
                setShown(report(c, { stationary: t?.held }))
              }}
            >
              <span>{c.label || 'unlabelled'}</span>
              <span className="prof-row-n">{c.raw.length}</span>
            </button>
          ))}
        </div>

        {shown && <StageReadout r={shown} />}
      </div>
    </div>
  )
}

function StageReadout({ r }: { r: Report }): JSX.Element {
  const rows: [string, string][] = []
  const px = (v: number): string => v.toFixed(3) + ' px'

  if (r.noise) {
    rows.push(['Noise sideways', px(r.noise.sdX)])
    rows.push(['Noise up/down', px(r.noise.sdY)])
    rows.push(['Noise overall', px(r.noise.rms)])
    rows.push(['Distinct positions', `${r.noise.distinctPositions} of ${r.samples}`])
  } else {
    rows.push(['Wobble typical', px(r.error.rms)])
    rows.push(['Wobble worst', px(r.error.peak)])
    if (r.bySpeed.length) {
      rows.push(['When slow', px(r.bySpeed[0].rmsError)])
      rows.push(['When fast', px(r.bySpeed[r.bySpeed.length - 1].rmsError)])
    }
  }
  rows.push(['Rate', `${r.timing.rateHz.toFixed(0)} per second`])
  rows.push([
    'Repeated positions',
    `${r.timing.repeatedPositions} of ${r.samples} carried no new position`
  ])
  rows.push(['Pressure levels', String(r.pressure.levels)])
  rows.push([
    'Pressure jitter',
    `${(r.pressure.jitterWhileStill * 100).toFixed(3)}% held, ${r.pressure.reversalsPerSecond.toFixed(0)} reversals/sec`
  ])
  if (r.trimmed > 0) rows.push(['Trimmed ends', `${r.trimmed} unsettled samples`])

  return (
    <div className="prof-report">
      {rows.map(([k, v]) => (
        <div className="prof-stat" key={k}>
          <span className="prof-stat-k">{k}</span>
          <span className="prof-stat-v">{v}</span>
        </div>
      ))}
    </div>
  )
}
