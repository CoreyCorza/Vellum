import type { StrokePoint } from '../types'

/**
 * Raw pen samples, recorded before anything in the app has touched them.
 *
 * The point of keeping these is that a stroke can then be replayed through any number
 * of filters offline and the results compared on identical input. Judging a stabiliser
 * by drawing a fresh line for each attempt compares a filter change against a different
 * hand movement, which is why tuning one by feel goes in circles.
 */
export interface RawSample {
  /** ms, from the event timeline. */
  t: number
  /** Document pixels. Whatever the input path handed the stroke engine. */
  x: number
  y: number
  pressure: number
  tilt: number
  twist: number
}

export interface Capture {
  version: 1
  /** What the recording is of, e.g. "ruler, horizontal, slow". Set by the user. */
  label: string
  /** Wall clock at the first sample, for ordering recordings. */
  startedAt: number
  /** Camera zoom while recording. Document pixels are screen pixels at 1. */
  viewScale: number
  /**
   * Where the canvas was panned to, so a document position can be turned back into a screen
   * position — and therefore into a position on the glass.
   *
   * Needed to compare two sessions. An error fixed to one spot on the tablet appears at a
   * different document coordinate after any pan, so without this a ripple that never moved
   * looks like one that did, and the question of whether it is fixed to the hardware cannot
   * be answered at all.
   */
  viewX: number
  viewY: number
  devicePixelRatio: number
  /** Which input path fed the engine, since they have different resolutions. */
  source: 'wintab' | 'pointer' | 'synthetic'
  /** The samples as they arrived, unfiltered and unresampled. */
  raw: RawSample[]
  /** What the app actually drew, so the current stabiliser can be scored too. */
  drawn: RawSample[]
}

const MAX_STROKES = 24
const MAX_SAMPLES_PER_STROKE = 20000

const sample = (p: StrokePoint): RawSample => ({
  t: p.t,
  x: p.x,
  y: p.y,
  pressure: p.pressure,
  tilt: p.tilt,
  twist: p.twist
})

/**
 * Keeps the last few strokes as they arrived.
 *
 * Always recording. A profiler you have to remember to arm is a profiler that misses the
 * one stroke that went wrong, and the cost here is an object per sample — at 200 Hz,
 * nothing next to compositing a dab.
 */
export class StrokeRecorder {
  private strokes: Capture[] = []
  private current: Capture | null = null

  /** Set by whichever input path is live, so a capture records where it came from. */
  source: Capture['source'] = 'pointer'
  /** Free text stored with the next stroke, for labelling a run of ruler tests. */
  label = ''
  /** Set by the renderer at startup; the engine itself never reads globals. */
  devicePixelRatio = 1

  get count(): number {
    return this.strokes.length
  }

  /** Whether a recording is in progress. */
  get recording(): boolean {
    return this.current !== null
  }

  /** Samples in the recording currently in progress, for a live readout. */
  get currentSampleCount(): number {
    return this.current ? this.current.raw.length : 0
  }

  get lastSampleCount(): number {
    return this.strokes.length ? this.strokes[this.strokes.length - 1].raw.length : 0
  }

  /** Every retained stroke, oldest first. */
  all(): readonly Capture[] {
    return this.strokes
  }

  last(): Capture | null {
    return this.strokes.length ? this.strokes[this.strokes.length - 1] : null
  }

  begin(p: StrokePoint, viewScale: number, viewX = 0, viewY = 0): void {
    this.current = {
      version: 1,
      label: this.label,
      startedAt: Date.now(),
      viewScale,
      viewX,
      viewY,
      devicePixelRatio: this.devicePixelRatio,
      source: this.source,
      raw: [sample(p)],
      drawn: []
    }
  }

  extend(p: StrokePoint): void {
    const c = this.current
    if (!c || c.raw.length >= MAX_SAMPLES_PER_STROKE) return
    c.raw.push(sample(p))
  }

  /** Called at stroke end with what the engine actually drew, for comparison. */
  end(drawn: readonly StrokePoint[]): void {
    const c = this.current
    this.current = null
    if (!c || c.raw.length < 2) return
    c.drawn = drawn.map(sample)
    this.strokes.push(c)
    while (this.strokes.length > MAX_STROKES) this.strokes.shift()
  }

  clear(): void {
    this.strokes.length = 0
    this.current = null
  }

  /** One stroke, or all of them, as JSON ready to write to a file. */
  toJSON(which: 'last' | 'all' = 'all'): string {
    const data = which === 'last' ? [this.last()].filter(Boolean) : this.strokes
    return JSON.stringify({ version: 1, recorded: data }, null, 1)
  }
}
