import { useRef, useState } from 'react'
import { useEditorState } from '../useEditor'
import { FloatingPanel } from './FloatingPanel'
import { saveText } from '../platform'
import { savePrefs } from '../prefs'
import type { Correction } from '@engine/diag/correction'
import { report, type Report } from '@engine/diag/analysis'
import { ProfilerStage } from './ProfilerStage'

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
  /**
   * The tests need the whole display: a ruler pass runs edge to edge, and a floating panel
   * in the way makes the most important recordings impossible to take.
   */
  const [stage, setStage] = useState(false)
  const [corrNote, setCorrNote] = useState('')

  /**
   * A blind test, because "it feels better" cannot be trusted by the person hoping it does.
   *
   * The correction is switched on or off at random and not shown. You draw, you guess, and the
   * tally is kept. Wanting it to work cannot help you guess, which is the entire point — it is
   * the only instrument here that is immune to the person holding it.
   */
  const [trial, setTrial] = useState<boolean | null>(null)
  const [tally, setTally] = useState({ right: 0, total: 0 })
  const beforeTrials = useRef<boolean | null>(null)

  const startTrial = (): void => {
    if (beforeTrials.current === null) beforeTrials.current = editor.distortionEnabled
    // The stabiliser removes exactly the kind of small wobble this test is looking for, so a run
    // with it on can only ever come back null. Switched off for the duration and restored after.
    editor.stabiliserBypass = true
    const on = Math.random() < 0.5
    setTrial(on)
    editor.distortionEnabled = on
    editor.ui.emit()
  }

  /**
   * Answer, and roll straight into the next trial.
   *
   * A test worth trusting needs eight or ten answers, and the first version made you press a
   * button between every one of them, which turns a two minute check into a chore and invites
   * you to stop early — exactly when the tally is least meaningful. Now one press starts a run
   * and the rest is draw, answer, draw, answer.
   *
   * Whether each guess was right is deliberately not shown until the run ends. Being told would
   * change how the next line is drawn and how the next answer is chosen, which is the difference
   * between a blind test and a coaching session.
   */
  const guess = (saidOn: boolean): void => {
    if (trial === null) return
    setTally((t) => ({ right: t.right + (saidOn === trial ? 1 : 0), total: t.total + 1 }))
    startTrial()
  }

  const endTrials = (): void => {
    setTrial(null)
    editor.stabiliserBypass = false
    if (beforeTrials.current !== null) {
      editor.distortionEnabled = beforeTrials.current
      beforeTrials.current = null
    }
    editor.ui.emit()
  }

  const startOver = (): void => {
    endTrials()
    setTally({ right: 0, total: 0 })
  }

  /**
   * How often a score this good would happen by luck alone.
   *
   * Reported instead of a verdict, because the honest answer to "is this real" is a probability
   * and a small number of trials cannot give more than that. Six out of six is worth more than
   * sixty out of a hundred, and this says so.
   */
  /**
   * The score this many trials would need before the result means anything.
   *
   * Shown alongside the tally so a middling score is not mistaken for proof of no effect. Fifteen
   * trials can only prove an effect if you can tell twelve times out of fifteen; noticing
   * two-thirds of the time is real and would need about forty trials to show.
   */
  const needed = (total: number): number => {
    for (let k = 0; k <= total; k++) if (byChance(k, total) < 0.05) return k
    return total
  }

  const byChance = (right: number, total: number): number => {
    if (total === 0) return 1
    const choose = (n: number, k: number): number => {
      let c = 1
      for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1)
      return c
    }
    let p = 0
    for (let k = right; k <= total; k++) p += choose(total, k) * Math.pow(0.5, total)
    return p
  }

  /**
   * Load a correction measured from ruler sweeps, and switch it on.
   *
   * Read from a file rather than fitted here, because fitting needs a set of sweeps at different
   * angles and placements that no one is going to redo on every launch. Once loaded it is kept in
   * preferences and applied to every pen sample.
   */
  const loadCorrection = async (file: File): Promise<void> => {
    try {
      const parsed = JSON.parse(await file.text()) as Correction
      editor.distortion = parsed
      editor.distortionEnabled = true
      savePrefs({ distortion: parsed, distortionEnabled: true })
      const bins = (parsed.x?.offsets.length ?? 0) + (parsed.y?.offsets.length ?? 0)
      setCorrNote(bins + ' bins loaded')
      editor.ui.emit()
    } catch {
      setCorrNote('could not read that file')
    }
  }

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

  if (stage) return <ProfilerStage onClose={() => setStage(false)} />

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

          {/* Correction — the payoff of everything the profiler measures. Deliberately a
              toggle rather than a slider: there is nothing to tune, it is either the
              measured distortion or it is not. */}
          <div className="prof-head">
            <span>Distortion correction</span>
          </div>
          <label className="chk" htmlFor="corr-on">
            <input
              id="corr-on"
              type="checkbox"
              checked={editor.distortionActive}
              disabled={!editor.distortion}
              onChange={(e) => {
                editor.distortionEnabled = e.target.checked
                savePrefs({ distortionEnabled: e.target.checked })
                editor.ui.emit()
              }}
            />
            {editor.distortion ? 'Correct my tablet' : 'Correct my tablet — nothing loaded'}
          </label>
          <p className="prof-how">
            {editor.distortion
              ? 'Subtracted from every pen sample. No smoothing and no lag: it only removes what was measured as fixed to the glass.'
              : 'Load a correction fitted from ruler sweeps to switch this on.'}
          </p>
          <div className="prof-actions">
            <label className="btn">
              Load correction…
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void loadCorrection(f)
                }}
              />
            </label>
            {corrNote && <span className="prof-saved">{corrNote}</span>}
          </div>

          {editor.distortion && (
            <>
              <div className="prof-head">
                <span>Blind test</span>
              </div>
              <p className="prof-how">
                {trial === null
                  ? 'Switches the correction on or off at random without telling you. Draw a line, say which it was, and it moves straight on to the next one. Your stabiliser is switched off for the run, since it removes the very thing you are trying to notice. Twelve or more trials.'
                  : `Trial ${tally.total + 1}. Draw a line or two, then answer. You will not be told whether you were right until you stop.`}
              </p>
              <div className="prof-actions">
                {trial === null ? (
                  <button className="btn" onClick={startTrial}>
                    {tally.total > 0 ? 'Carry on' : 'Start blind test'}
                  </button>
                ) : (
                  <>
                    <button className="btn" onClick={() => guess(true)}>
                      It was on
                    </button>
                    <button className="btn" onClick={() => guess(false)}>
                      It was off
                    </button>
                    <button className="btn" onClick={endTrials}>
                      Stop
                    </button>
                  </>
                )}
                {trial === null && tally.total > 0 && (
                  <button className="btn" onClick={startOver}>
                    Start over
                  </button>
                )}
              </div>
              {tally.total > 0 && trial === null && (
                <div className="prof-report">
                  <div className="prof-stat">
                    <span className="prof-stat-k">Correct</span>
                    <span className="prof-stat-v">
                      {tally.right} of {tally.total}
                    </span>
                  </div>
                  <div className="prof-stat">
                    <span className="prof-stat-k">By luck alone</span>
                    <span className="prof-stat-v">
                      {(byChance(tally.right, tally.total) * 100).toFixed(0)}% of the time
                    </span>
                  </div>
                  <div className="prof-stat">
                    <span className="prof-stat-k">Reading</span>
                    <span className="prof-stat-v">
                      {byChance(tally.right, tally.total) < 0.05
                        ? 'you can tell'
                        : byChance(tally.right, tally.total) < 0.2
                          ? 'probably — carry on'
                          : 'not shown either way'}
                    </span>
                  </div>
                  {/* What this many trials is capable of showing, so a null result is not read
                      as proof of nothing. A short run can only reveal a strong effect. */}
                  <div className="prof-stat">
                    <span className="prof-stat-k">Needed to prove it</span>
                    <span className="prof-stat-v">{needed(tally.total)} of {tally.total}</span>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="prof-actions">
            <button className="btn prof-go" onClick={() => setStage(true)}>
              Full screen…
            </button>
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
