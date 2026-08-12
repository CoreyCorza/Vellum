import { Surface } from '../surface'
import { GLStrokeRenderer } from '../gl/strokeRenderer'
import { StrokeEngine } from './stroke'
import { presetSettings, type BrushPreset } from './presets'
import type { BrushSettings } from './settings'
import type { StrokePoint } from '../types'

/** Drawn at 2x and displayed at half, so the preview is crisp on any display. */
const SCALE = 2
const PAPER = '#f7f4ee'
const INK = '#1b1f24'

/**
 * Stroke previews for the preset list, drawn by the real brush engine.
 *
 * The alternative was faking them with a few canvas gradients, which would drift
 * from what the brush actually does the moment anything in the engine changed.
 * Running the genuine dab loop means a preview is a promise the app keeps: the
 * mark in the list is the mark you get.
 *
 * ONE small WebGL context is shared by every preset — browsers cap how many a
 * page may hold, so a renderer per thumbnail would eventually fail outright.
 *
 * Previews are not to scale. A 120px airbrush cannot show at true size in a strip
 * 22px tall, so size is compressed into the strip and the number beside the name
 * carries the truth. Photoshop does the same.
 */
export class PresetThumbnails {
  private gl: GLStrokeRenderer | null = null
  private engine: StrokeEngine | null = null
  private surface: Surface | null = null
  private current: BrushSettings | null = null
  private cache = new Map<string, string>()

  constructor(
    private readonly w = 104,
    private readonly h = 22
  ) {}

  /** A data URL for this preset, generated once and kept. */
  get(preset: BrushPreset): string {
    if (preset.icon) return preset.icon
    const hit = this.cache.get(preset.id)
    if (hit) return hit
    const url = this.render(preset)
    this.cache.set(preset.id, url)
    return url
  }

  /**
   * A preview of loose settings rather than a saved preset, for the live strip in
   * the settings panel. Uncached on purpose: the whole point is that it changes as
   * the sliders move.
   */
  live(settings: BrushSettings, erase: boolean): string {
    return this.render({ id: 'live', name: '', erase, settings })
  }

  /** Drop one preset's preview, or all of them, after an edit. */
  invalidate(id?: string): void {
    if (id === undefined) this.cache.clear()
    else this.cache.delete(id)
  }

  private ensure(): boolean {
    if (this.gl) return true
    try {
      const w = this.w * SCALE
      const h = this.h * SCALE
      this.gl = new GLStrokeRenderer(w, h)
      this.surface = new Surface(w, h)
      this.engine = new StrokeEngine(() => this.current ?? presetSettings(BLANK))
      return true
    } catch {
      // No WebGL2 — previews degrade to a plain swatch rather than taking the
      // panel down with them.
      this.gl = null
      return false
    }
  }

  private render(preset: BrushPreset): string {
    if (!this.ensure() || !this.gl || !this.engine || !this.surface) return ''
    const w = this.w * SCALE
    const h = this.h * SCALE

    const s = presetSettings(preset)
    // The stabiliser lags the pen deliberately; on a synthetic path it would only
    // shorten the stroke. Spacing and everything else stay as the preset has them.
    this.current = { ...s, stabilise: 0, stabiliseSpeedAdapt: 0, color: INK, symmetry: 'none' }
    this.current.size = this.previewSize(s.size, h)

    const g = this.surface.ctx
    this.surface.clear()

    // An eraser has to read as an eraser: lay a band down, then take the stroke
    // out of it. A black smear would just say "brush".
    if (preset.erase) {
      const grd = g.createLinearGradient(0, 0, 0, h)
      grd.addColorStop(0, '#8b939c')
      grd.addColorStop(1, '#6c757f')
      g.fillStyle = grd
      g.fillRect(0, 0, w, h)
    } else {
      this.surface.fill(PAPER)
    }

    this.gl.beginStroke()
    this.engine.begin(this.gl, this.point(0, w, h, preset), false, w, h)
    const N = 48
    for (let i = 1; i <= N; i++) this.engine.extend(this.point(i / N, w, h, preset))
    this.engine.end()
    this.gl.resolve(INK)
    this.surface.draw(this.gl, 1, preset.erase ? 'destination-out' : 'source-over')

    // Erasing leaves a HOLE, not paper. Left transparent it shows the dark panel
    // through it and the preview reads as a black brush stroke — the exact
    // opposite of what an eraser does. Paper goes in behind, so the stroke reads
    // as paint lifted off.
    if (preset.erase) {
      g.save()
      g.globalCompositeOperation = 'destination-over'
      g.fillStyle = PAPER
      g.fillRect(0, 0, w, h)
      g.restore()
    }

    return this.surface.canvas.toDataURL('image/png')
  }

  /** Compress the real size into the strip, spread so 2px and 24px still differ. */
  private previewSize(size: number, h: number): number {
    // Capped as well as fitted: without the cap a 120px brush fills a square tile
    // edge to edge and every big preset looks identical.
    const maxR = Math.min(h / 2 - 2 * SCALE, 14 * SCALE)
    const r = Math.max(0.6 * SCALE, maxR * Math.pow(Math.min(size, 200) / 120, 0.58))
    return r * 2
  }

  /** A shallow S with a hand-like pressure envelope: light in, swelling, lifting
   *  off. Pressure only shows if the preset asked for it. */
  private point(t: number, w: number, h: number, preset: BrushPreset): StrokePoint {
    const inset = 3 * SCALE + (this.current?.size ?? 2) / 2
    const x = inset + t * Math.max(1, w - inset * 2)
    const amp = h / 2 - (this.current?.size ?? 2) / 2 - 1
    const waves = h > w * 0.6 ? 1.0 : 1.7
    const y = h / 2 - Math.sin(t * Math.PI * waves - 0.5) * Math.max(0, amp) * 0.6
    const swell = Math.sin(Math.pow(t, 0.78) * Math.PI)
    const pressure = preset.erase ? 0.65 + 0.35 * swell : 0.1 + 0.9 * swell
    return { x, y, pressure: Math.max(0.02, pressure), tilt: 0, twist: 0, t: t * 900 }
  }
}

const BLANK: BrushPreset = { id: '', name: '', erase: false, settings: {} }
