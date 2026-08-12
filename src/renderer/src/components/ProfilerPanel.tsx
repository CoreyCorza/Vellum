import { useState } from 'react'
import { useEditorState } from '../useEditor'
import { FloatingPanel } from './FloatingPanel'
import { saveText } from '../platform'
import { report, type Report } from '@engine/diag/analysis'

/**
 * Measuring the tablet instead of arguing with it.
 *
 * Every pen digitiser wobbles, and how much is a property of the hardware that reviewers
 * demonstrate by drawing a line against a ruler and pointing at it. That test is sound and
 * the conclusion is unmeasurable: a picture of a wobbly line cannot say how large the
 * wobble is, whether it is the tablet or the hand, or whether it repeats.
 *
 * So the strokes are recorded raw, before the app has touched them, and measured against
 * the line they were trying to be. Two things come out that are impossible to see by eye.
 * First, how big the wobble actually is, in pixels, so a change can be shown to have
 * helped rather than felt like it did. Second, whether it repeats — and if it does,
 * whether it repeats in time or in distance, which is the difference between the
 * electronics and the sensor grid, and decides what a fix could even look like.
 *
 * The tests are listed rather than described because the recording has to be done a
 * particular way to mean anything, and a stroke drawn freehand while thinking about
 * something else measures the hand.
 */

interface Test {
  id: string
  label: string
  how: string
  /** Held-pen tests measure the digitiser alone; the analysis differs. */
  held?: boolean
}

const TESTS: Test[] = [
  {
    id: 'still',
    label: 'Pen held still',
    how: 'Rest the pen against something so it cannot move, press down, and leave it for ten seconds. No hand movement at all.',
    held: true
  },
  { id: 'h-slow', label: 'Horizontal, slow', how: 'Ruler across the screen. One slow pass, about five seconds.' },
  { id: 'h-fast', label: 'Horizontal, fast', how: 'Same ruler, one quick pass.' },
  { id: 'v-slow', label: 'Vertical, slow', how: 'Ruler upright. One slow pass.' },
  { id: 'v-fast', label: 'Vertical, fast', how: 'Same, one quick pass.' },
  { id: 'd-slow', label: 'Diagonal, slow', how: 'Ruler at roughly 45 degrees. One slow pass.' },
  { id: 'd-fast', label: 'Diagonal, fast', how: 'Same, one quick pass.' },
  { id: 'free', label: 'Anything else', how: 'Whatever you want to measure. Label it yourself.' }
]

const px = (v: number): string => v.toFixed(2) + ' px'

export function ProfilerPanel(): JSX.Element {
  const editor = useEditorState()
  const [test, setTest] = useState<Test>(TESTS[0])
  const [shown, setShown] = useState<Report | null>(null)
  const [saved, setSaved] = useState('')

  const recorder = editor.recorder
  const captures = recorder.all()

  const arm = (t: Test): void => {
    setTest(t)
    recorder.label = t.id
  }

  const measure = (i: number): void => {
    const c = captures[i]
    const t = TESTS.find((x) => x.id === c.label)
    setShown(report(c, { stationary: t?.held }))
  }

  const save = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const where = await saveText(recorder.toJSON('all'), `vellum-tablet-${stamp}.json`)
    setSaved(typeof where === 'string' ? 'Saved' : where ? 'Downloaded' : '')
  }

  return (
    <FloatingPanel
      id="profiler-panel"
      title="Tablet Profiler"
      initialTop={10}
      initialRight={700}
      initialWidth={430}
      initialHeight={560}
    >
      <div className="prof">
        <div className="prof-tests" role="tablist" aria-label="Tests">
          {TESTS.map((t) => (
            <button
              key={t.id}
              className="cat-item"
              role="tab"
              aria-selected={t.id === test.id}
              onClick={() => arm(t)}
            >
              <span className="cat-name">{t.label}</span>
              {captures.some((c) => c.label === t.id) && <span className="cat-dot" aria-label="recorded" />}
            </button>
          ))}
        </div>

        <div className="prof-body">
          <p className="prof-how">{test.how}</p>

          <div className="prof-head">
            <span>Recorded</span>
            <span className="prof-count">{captures.length}</span>
          </div>

          <div className="prof-list">
            {captures.length === 0 && <p className="prof-empty">Draw one of the tests above.</p>}
            {captures.map((c, i) => (
              <button key={i} className="prof-row" onClick={() => measure(i)}>
                <span className="prof-row-label">{c.label || 'unlabelled'}</span>
                <span className="prof-row-n">{c.raw.length} samples</span>
              </button>
            ))}
          </div>

          {shown && <Readout r={shown} />}

          <div className="prof-actions">
            <button className="btn" onClick={save} disabled={captures.length === 0}>
              Save capture…
            </button>
            <button
              className="btn"
              onClick={() => {
                recorder.clear()
                setShown(null)
                setSaved('')
              }}
              disabled={captures.length === 0}
            >
              Clear
            </button>
            {saved && <span className="prof-saved">{saved}</span>}
          </div>
        </div>
      </div>
    </FloatingPanel>
  )
}

/**
 * The numbers, with the reading attached.
 *
 * A bare figure is not usable by anyone who has not spent the afternoon in the maths, so
 * each one says what it means. The periodic components are deliberately reported as "no
 * pattern" when they are weak: a spectrum always has a largest bin, and presenting that
 * bin as a finding would invent a resonance in every tablet ever measured.
 */
function Readout({ r }: { r: Report }): JSX.Element {
  const rows: [string, string][] = []

  rows.push(['Read as', r.treatedAs])
  rows.push(['Samples', `${r.samples} at ${r.timing.rateHz.toFixed(0)} per second`])
  rows.push([
    'Timing evenness',
    `${r.timing.meanIntervalMs.toFixed(2)} ms apart, varying by ${r.timing.sdIntervalMs.toFixed(2)} ms`
  ])
  rows.push([
    'Finest step',
    r.timing.finestStep >= 0.999
      ? `${r.timing.finestStep.toFixed(2)} px — whole pixels only`
      : `${r.timing.finestStep.toFixed(3)} px — real sub-pixel detail`
  ])

  if (r.noise) {
    rows.push(['Noise, sideways', px(r.noise.sdX)])
    rows.push(['Noise, up and down', px(r.noise.sdY)])
    rows.push(['Noise, overall', px(r.noise.rms)])
    rows.push(['Worst swing', `${px(r.noise.peakToPeakX)} by ${px(r.noise.peakToPeakY)}`])
    rows.push(['Distinct positions', String(r.noise.distinctPositions)])
  } else {
    rows.push(['Wobble, typical', px(r.error.rms)])
    rows.push(['Wobble, worst', px(r.error.peak)])
    rows.push(['Wobble, full swing', px(r.error.peakToPeak)])
    if (r.drawnError) {
      const cut = r.error.rms > 0 ? (1 - r.drawnError.rms / r.error.rms) * 100 : 0
      rows.push([
        'After your stabiliser',
        `${px(r.drawnError.rms)} — ${cut >= 0 ? cut.toFixed(0) + '% less' : Math.abs(cut).toFixed(0) + '% more'}`
      ])
    }
  }

  const pattern = (p: typeof r.inTime, unit: string, what: string): void => {
    if (!p || p.prominence < 15) {
      rows.push([what, 'no pattern — just noise'])
      return
    }
    if (!p.wellSampled) {
      rows.push([what, 'too fast to measure at this sample rate'])
      return
    }
    rows.push([
      what,
      `every ${p.period.toFixed(2)} ${unit}, about ${px(p.amplitude)} of it`
    ])
  }
  pattern(r.inTime, 'seconds', 'Repeats in time')
  pattern(r.inDistance, 'px travelled', 'Repeats in distance')

  for (const b of r.bySpeed) {
    rows.push([b.label === 'slowest quarter' ? 'Wobble when slow' : b.label === 'fastest quarter' ? 'Wobble when fast' : b.label, px(b.rmsError)])
  }

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
