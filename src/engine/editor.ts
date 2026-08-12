import { PaintDocument, Layer } from './document'
import { Surface } from './surface'
import { Camera } from './camera'
import { Compositor } from './compositor'
import { History, PixelPatch, ActionCommand } from './history'
import { StrokeEngine } from './brush/stroke'
import { NavDrag } from './gestures'
import { GLStrokeRenderer } from './gl/strokeRenderer'
import { DEFAULT_BRUSH, type BrushSettings } from './brush/settings'
import { BUILT_IN_PRESETS, presetSettings, settingsDiffer, type BrushPreset } from './brush/presets'
import type {
  BlendMode,
  CanvasScalingMode,
  CursorStyle,
  Pt,
  Rect,
  StrokePoint,
  ToolId
} from './types'
import { clamp } from './types'
import { MipPyramid } from './mipmap'

class Emitter {
  private listeners = new Set<() => void>()
  version = 0
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = (): number => this.version
  emit(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }
}

export type ScrubSource = 'pointer' | 'keys'

/** Exponential rate for brush-size scrubbing: ~2.7x per 100px of travel, so the
 *  full 1..400 range is a ~600px sweep and the feel is identical at any zoom. */
export const SIZE_SCRUB_RATE = 0.01

export interface Telemetry {
  pointerType: string
  pressure: number
  tiltX: number
  tiltY: number
  twist: number
  docX: number
  docY: number
  rateHz: number
  fps: number
}

/**
 * Zoom band over which a magnified canvas cross-fades from SMOOTH to CRISP.
 *
 * Smooth at and just above 1:1, exact pixels from CRISP_FROM up. That is the
 * direction Photoshop, Krita and Clip Studio all go; the first two snap at
 * roughly 200%, Clip Studio ramps. At 1x the two filters agree anyway, since
 * nothing is being resampled, so the ramp can start there for free.
 */
const SMOOTH_UNTIL = 1.0
const CRISP_FROM = 2.0

/**
 * Owns the document and drives the frame loop. This is the seam the UI talks to
 * — React reads state through `ui.subscribe` and calls methods here. Nothing in
 * `src/engine` imports React, and nothing in the UI touches pixels directly.
 */
export class Editor {
  readonly doc: PaintDocument
  readonly camera: Camera
  readonly history = new History()
  readonly compositor: Compositor

  /**
   * Pan / rotate / zoom drag state — ONE instance, shared by every input path.
   *
   * It used to be constructed separately inside bindPointerInput and
   * bindWintabInput. Each kept its own "last position", so whenever both had a
   * drag live they each applied the whole delta and the canvas travelled twice
   * as far as the hand. That is easy to trigger with Windows Ink off, where the
   * tablet shadows every Wintab packet with a synthetic mouse event. Sharing
   * the state makes the second caller a no-op instead of a doubling.
   */
  readonly nav = new NavDrag()

  /**
   * One preset per tool. The eraser is just its own brush: same settings, same
   * panel, its own values. A soft brush and a hard eraser need no explaining,
   * and understanding any number in the panel never requires knowing where it
   * came from.
   */
  private brushSettings: BrushSettings = { ...DEFAULT_BRUSH }
  private eraserSettings: BrushSettings = { ...DEFAULT_BRUSH }

  /** The selected tool's settings — what the panel edits and shows. */
  get brush(): BrushSettings {
    return this.tool === 'eraser' ? this.eraserSettings : this.brushSettings
  }

  /** Settings for a STROKE, which is a different question: flipping the pen over
   *  erases without changing the selected tool. */
  settingsFor(erasing: boolean): BrushSettings {
    return erasing ? this.eraserSettings : this.brushSettings
  }

  /** For persistence. */
  get eraserBrush(): BrushSettings {
    return this.eraserSettings
  }

  /**
   * The preset shelf. Erasers sit here with the brushes, because from the user's
   * side an eraser is a brush that takes paint off, and people keep several.
   */
  presets: BrushPreset[] = BUILT_IN_PRESETS.map((p) => ({ ...p }))
  activePresetId: string | null = null

  /**
   * Load a preset. An erase preset switches you into erase mode as part of
   * choosing it — picking "Eraser · hard" and then still painting would be absurd.
   */
  applyPreset(id: string): void {
    const preset = this.presets.find((p) => p.id === id)
    if (!preset) return
    const settings = presetSettings(preset)
    if (preset.erase) {
      this.eraserSettings = { ...settings, color: this.brushSettings.color, symmetry: this.brushSettings.symmetry }
      this.tool = 'eraser'
    } else {
      const keepColour = this.brushSettings.color
      this.brushSettings = { ...settings, color: keepColour, symmetry: this.brushSettings.symmetry }
      this.tool = 'brush'
    }
    this.activePresetId = id
    this.strokes.invalidateTip()
    this.invalidate()
    this.ui.emit()
  }

  /**
   * Add a preset. From the current brush, or a fresh default one.
   *
   * Taking it from the current tool means making an eraser preset is the same
   * gesture as making a brush preset — set up an eraser you like, press the
   * button, it lands on the shelf as an eraser.
   */
  addPreset(fromCurrent: boolean): string {
    const erase = fromCurrent ? this.tool === 'eraser' : false
    const settings = fromCurrent ? { ...this.brush } : { ...DEFAULT_BRUSH }
    const stem = erase ? 'Eraser' : 'Brush'
    let n = 1
    while (this.presets.some((p) => p.name === `${stem} ${n}`)) n++
    const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.presets = [...this.presets, { id, name: `${stem} ${n}`, erase, settings }]
    this.activePresetId = id
    this.ui.emit()
    return id
  }

  /**
   * Is the live brush different from the preset it came from?
   *
   * Editing a slider used to CLEAR the selection, on the theory that the brush was
   * then no longer that preset. It made the settings panel appear to be editing
   * nothing, and the only way to get the highlight back was to click the preset
   * again, which reloaded it and threw the edits away. Selection now survives
   * editing and the preset is marked as modified instead — the same thing Krita,
   * Photoshop and Clip Studio all do.
   */
  get presetModified(): boolean {
    if (!this.activePresetId) return false
    const preset = this.presets.find((p) => p.id === this.activePresetId)
    if (!preset) return false
    if (preset.erase !== (this.tool === 'eraser')) return true
    return settingsDiffer(this.brush, presetSettings(preset))
  }

  /** Throw away the edits and load the selected preset again. */
  revertPreset(): void {
    if (this.activePresetId) this.applyPreset(this.activePresetId)
  }

  deletePreset(id: string): void {
    this.presets = this.presets.filter((p) => p.id !== id)
    if (this.activePresetId === id) this.activePresetId = null
    this.ui.emit()
  }

  renamePreset(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    this.presets = this.presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p))
    this.ui.emit()
  }

  /** Overwrite a preset with whatever the brush is set to now. */
  updatePresetFromBrush(id: string): void {
    const settings = { ...this.brush }
    this.presets = this.presets.map((p) =>
      p.id === id ? { ...p, erase: this.tool === 'eraser', settings } : p
    )
    this.activePresetId = id
    this.ui.emit()
  }

  /**
   * Put the built-in brushes back, keeping anything the user made.
   *
   * Without this, deleting a built-in is a one-way trip with no route back from
   * inside the app — which makes a mis-click on Delete unrecoverable rather than
   * merely annoying.
   */
  restoreDefaultPresets(): void {
    const mine = this.presets.filter((p) => p.id.startsWith('user-'))
    const builtIns = BUILT_IN_PRESETS.map((p) => ({ ...p, settings: presetSettings(p) }))
    this.presets = [...builtIns, ...mine]
    this.ui.emit()
  }

  /** Restore the saved shelf at boot; the caller validates it. */
  restorePresets(list: BrushPreset[]): void {
    if (list.length === 0) return
    this.presets = list.map((p) => ({ ...p }))
    this.ui.emit()
  }

  /** Restore the saved eraser preset at boot; the caller validates it. Colour
   *  and symmetry are global, so they are not taken from storage here. */
  restoreEraserBrush(saved: BrushSettings): void {
    this.eraserSettings = {
      ...saved,
      color: this.brushSettings.color,
      symmetry: this.brushSettings.symmetry
    }
    this.strokes.invalidateTip()
    this.invalidate()
    this.ui.emit()
  }
  tool: ToolId = 'brush'

  /**
   * Strokes finished since launch. Not statistics — the spring-loaded eraser
   * needs to know whether the tool was USED while its key was held, which is
   * what separates "hold E to erase a bit" from "tap E to switch to it".
   */
  strokesCommitted = 0

  /**
   * Where pen input comes from. When 'wintab', the Pointer Events layer ignores
   * `pointerType === 'pen'` entirely so the two sources cannot both drive the
   * same stroke. Mouse and touch always stay on Pointer Events.
   */
  penSource: 'pointer' | 'wintab' = 'pointer'

  /**
   * `performance.now()` of the most recent Wintab sample.
   *
   * Checking `pointerType === 'pen'` is NOT enough to keep the two sources
   * apart. With "Use Windows Ink" switched off — the configuration Wintab
   * exists to support — the tablet still drives the system cursor, so Chromium
   * reports the stylus as `pointerType: 'mouse'`. Those events used to reach
   * the brush at `pressure = 1`, interleaved with the real Wintab samples,
   * producing blotchy strokes that alternated between tapered and full width.
   *
   * So suppression is by RECENCY, not by pointer type: while Wintab is
   * actively reporting, Pointer Events is ignored for the pen. Pick up a real
   * mouse and packets stop arriving, so it takes over again within the window.
   */
  lastWintabAt = -Infinity

  get wintabRecent(): boolean {
    return this.penSource === 'wintab' && performance.now() - this.lastWintabAt < 250
  }

  /** Fires when something the panels display has changed. */
  readonly ui = new Emitter()
  /** Fires at ~15 Hz with pen data — kept separate so pointer traffic never
   *  re-renders the whole panel tree. */
  readonly telemetryChannel = new Emitter()
  telemetry: Telemetry = {
    pointerType: '—', pressure: 0, tiltX: 0, tiltY: 0, twist: 0,
    docX: 0, docY: 0, rateHz: 0, fps: 0
  }

  private strokes: StrokeEngine
  /**
   * The live stroke, rendered by WebGL2.
   *
   * Replaces what used to be three Canvas 2D surfaces (coverage buffer, ceiling
   * buffer, mask scratch) plus a luminance filter, all of which existed to
   * approximate a conditional blend that Canvas 2D cannot perform. The shader
   * just does it. Its canvas holds the already-resolved stroke, so committing is
   * still a single drawImage into the layer.
   */
  private glStroke: GLStrokeRenderer

  /** Shared by the zoomed-out viewport and, later, the navigator thumbnail. */
  private mips = new MipPyramid()

  /** Layer pixels changed: the composite and its mip pyramid are both stale. */
  private contentChanged(): void {
    this.compositor.invalidate()
    this.mips.invalidate()
  }

  /** Pre-stroke copy of the active layer, so undo can read back just the rect
   *  the stroke actually touched without a CPU snapshot up front. */
  private backup: Surface
  private strokeLayer: Layer | null = null

  private display: HTMLCanvasElement | null = null
  private dsp: CanvasRenderingContext2D | null = null
  private dpr = 1
  private needsRender = true
  private rafId = 0

  private checker: HTMLCanvasElement

  cursor = { x: -9999, y: -9999, visible: false }
  cursorStyle: CursorStyle = 'brush'
  canvasScalingMode: CanvasScalingMode = 'auto'

  setCursorStyle(style: CursorStyle): void {
    this.cursorStyle = style
    this.invalidate()
    this.ui.emit()
  }
  setCanvasScalingMode(mode: CanvasScalingMode): void {
    this.canvasScalingMode = mode
    this.invalidate()
    this.ui.emit()
  }
  /** Anchor for the size-scrub preview. While active it replaces the cursor
   *  ring, so the brush grows concentrically instead of chasing the pen. */
  sizePreview = { active: false, x: 0, y: 0 }
  private scrub: { originX: number; startSize: number; source: ScrubSource } | null = null

  private frameCount = 0
  private frameTime = 0
  private sampleCount = 0
  private sampleTime = 0
  private lastTelemetryEmit = 0

  constructor(width: number, height: number) {
    this.doc = new PaintDocument(width, height)
    this.camera = new Camera(width, height)
    this.compositor = new Compositor(width, height)
    this.glStroke = new GLStrokeRenderer(width, height)
    this.backup = new Surface(width, height)
    this.strokes = new StrokeEngine(() => this.settingsFor(this.strokes.erasing))
    this.checker = makeChecker()

    this.history.onChange = () => {
      this.contentChanged()
      this.invalidate()
      this.ui.emit()
    }

    this.doc.layers[0].surface.fill('#f2ece0')
  }

  // ------------------------------------------------------------------ display

  attach(canvas: HTMLCanvasElement): void {
    this.display = canvas
    // alpha:false skips a blend the compositor already handled;
    // desynchronized lets Chromium shortcut a compositing hop for stylus input.
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new Error('Editor: could not acquire a display context')
    this.dsp = ctx
    this.frameTime = performance.now()
    this.sampleTime = this.frameTime
    const loop = (): void => {
      this.rafId = requestAnimationFrame(loop)
      this.frame()
    }
    this.rafId = requestAnimationFrame(loop)
  }

  detach(): void {
    cancelAnimationFrame(this.rafId)
    this.display = null
    this.dsp = null
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    if (!this.display) return
    this.dpr = Math.min(dpr, 2)
    this.camera.setViewport(cssW, cssH)
    this.display.width = Math.max(1, Math.round(cssW * this.dpr))
    this.display.height = Math.max(1, Math.round(cssH * this.dpr))
    this.display.style.width = `${cssW}px`
    this.display.style.height = `${cssH}px`
    this.invalidate()
  }

  invalidate(): void {
    this.needsRender = true
  }

  // -------------------------------------------------------------------- tools

  setTool(t: ToolId): void {
    this.tool = t
    // The two presets can differ in hardness, so the cursor's tip is stale.
    this.strokes.invalidateTip()
    this.invalidate()
    this.ui.emit()
  }

  // ---------------------------------------------------------------- size scrub

  get sizeScrubActive(): boolean {
    return this.scrub !== null
  }

  /**
   * Two bindings drive this, and they must not fight each other:
   *   'pointer' — alt + right-drag, ended by pointerup
   *   'keys'    — hold S and move the pen, ended by keyup
   *
   * The second exists because a pen barrel button mapped to right-click makes
   * Windows Ink draw its own ring under the nib, which no application can
   * suppress. Holding a key and moving — in contact or just hovering — never
   * produces a right-click, so the ring never appears. It is also the binding
   * to use if you map a pen button to a keystroke in the tablet driver.
   */
  /**
   * Show the size ring without arming a scrub.
   *
   * Dragging a size slider changes a number, and a number in pixels is not
   * something anyone can picture — "34" means nothing until you have drawn with
   * it. The same ring the Alt+RMB scrub draws is the answer, so this shows it while
   * a slider is being dragged. Defaults to the middle of the viewport, since the
   * pen is over a panel rather than the canvas.
   */
  showSizePreview(x?: number, y?: number): void {
    // Where you last had the pen, falling back to the middle of the viewport. The
    // last position is the better default: it is the part of the drawing you were
    // working on, so the ring appears in context rather than over a panel.
    const seen = this.cursor.x > -9000 && this.cursor.y > -9000
    this.sizePreview.active = true
    this.sizePreview.x = x ?? (seen ? this.cursor.x : this.camera.vw / 2)
    this.sizePreview.y = y ?? (seen ? this.cursor.y : this.camera.vh / 2)
    this.invalidate()
  }

  hideSizePreview(): void {
    if (!this.sizePreview.active) return
    this.sizePreview.active = false
    this.invalidate()
  }

  beginSizeScrub(x: number, y: number, source: ScrubSource): void {
    if (this.scrub) return
    this.scrub = { originX: x, startSize: this.brush.size, source }
    this.sizePreview.active = true
    this.sizePreview.x = x
    this.sizePreview.y = y
    this.invalidate()
  }

  updateSizeScrub(x: number): void {
    const s = this.scrub
    if (!s) return
    this.setBrush({
      size: clamp(s.startSize * Math.exp((x - s.originX) * SIZE_SCRUB_RATE), 1, 400)
    })
  }

  /** Only the binding that started the scrub may end it. */
  endSizeScrub(source: ScrubSource): void {
    if (!this.scrub || this.scrub.source !== source) return
    this.scrub = null
    this.sizePreview.active = false
    this.invalidate()
  }

  setBrush(patch: Partial<BrushSettings>): void {
    Object.assign(this.brush, patch)


    // Colour and symmetry are global, as in Photoshop. An eraser has no colour,
    // so choosing one while it is selected has to set what you paint with next
    // rather than disappear into a tool that cannot show it; and symmetry
    // belongs to the canvas, not to a tool.
    if (patch.color !== undefined) {
      this.brushSettings.color = patch.color
      this.eraserSettings.color = patch.color
    }
    if (patch.symmetry !== undefined) {
      this.brushSettings.symmetry = patch.symmetry
      this.eraserSettings.symmetry = patch.symmetry
    }

    if (patch.hardness !== undefined || patch.color !== undefined) {
      this.strokes.invalidateTip()
    }
    this.invalidate()
    this.ui.emit()
  }

  // ------------------------------------------------------------------ strokes

  get strokeActive(): boolean {
    return this.strokes.active
  }

  /** Single-sample pressure spikes rejected during the last stroke. */
  get debugSpikesRejected(): number {
    return this.strokes.spikesRejected
  }

  /** Raw stroke accumulation channels at a document pixel. Diagnostics only. */
  debugAccum(x: number, y: number): { r: number; g: number; b: number; a: number } {
    return this.glStroke.debugSampleAccum(x, y)
  }

  /** Stabilised samples of the in-flight stroke. Diagnostics only. */
  get debugStrokePoints(): readonly import('./types').StrokePoint[] {
    return this.strokes.stabilisedPoints
  }

  beginStroke(p: StrokePoint, erasing: boolean): void {
    const layer = this.doc.active
    if (layer.locked || !layer.visible) return
    this.strokeLayer = layer
    this.backup.copyFrom(layer.surface)
    this.glStroke.beginStroke()
    this.strokes.begin(
      this.glStroke,
      p,
      erasing,
      this.doc.width,
      this.doc.height,
      this.camera.scale
    )
    this.invalidate()
  }

  extendStroke(p: StrokePoint): void {
    this.strokes.extend(p)
    this.sampleCount++
    this.invalidate()
  }

  endStroke(): void {
    if (!this.strokes.active) return
    this.strokesCommitted++
    const erasing = this.strokes.erasing
    this.strokes.end()

    const layer = this.strokeLayer
    this.strokeLayer = null
    const rect = this.strokes.bounds.toRect(this.doc.width, this.doc.height)

    if (layer && rect.w > 0 && rect.h > 0) {
      const before = this.backup.extract(rect)
      const op: GlobalCompositeOperation = erasing ? 'destination-out' : 'source-over'
      // Already resolved by the shader — alpha is min(coverage, ceiling) and the
      // colour is applied, so the commit is a plain blit at full strength.
      this.glStroke.resolve(this.brush.color)
      layer.surface.draw(this.glStroke, 1, op, rect)
      this.history.push(
        new PixelPatch(erasing ? 'Erase' : 'Paint', layer, rect, before)
      )
    }
    this.strokes.bounds.reset()
    this.invalidate()
  }

  cancelStroke(): void {
    if (!this.strokes.active) return
    this.strokes.cancel()
    this.strokeLayer = null
    this.invalidate()
  }

  // ------------------------------------------------------------------- layers

  addLayer(): void {
    const at = this.doc.activeIndex
    const layer = this.doc.addLayer(undefined, at)
    const index = this.doc.indexOf(layer)
    this.history.push(
      new ActionCommand(
        'Add layer',
        () => {
          this.doc.layers.splice(this.doc.indexOf(layer), 1)
          this.doc.activeIndex = clamp(index - 1, 0, this.doc.layers.length - 1)
          this.doc.touch()
        },
        () => this.doc.insertLayer(layer, index)
      )
    )
  }

  duplicateLayer(): void {
    const src = this.doc.active
    const copy = new Layer(this.doc.width, this.doc.height, `${src.name} copy`)
    copy.surface.copyFrom(src.surface)
    copy.opacity = src.opacity
    copy.blend = src.blend
    const index = this.doc.activeIndex + 1
    this.doc.insertLayer(copy, index)
    this.history.push(
      new ActionCommand(
        'Duplicate layer',
        () => {
          this.doc.layers.splice(this.doc.indexOf(copy), 1)
          this.doc.activeIndex = clamp(index - 1, 0, this.doc.layers.length - 1)
          this.doc.touch()
        },
        () => this.doc.insertLayer(copy, index)
      )
    )
  }

  removeLayer(index = this.doc.activeIndex): void {
    if (this.doc.layers.length <= 1) return
    const layer = this.doc.layers[index]
    const gone = this.doc.removeLayer(index)
    if (!gone) return
    this.history.push(
      new ActionCommand(
        'Delete layer',
        () => this.doc.insertLayer(layer, index),
        () => {
          this.doc.layers.splice(this.doc.indexOf(layer), 1)
          this.doc.activeIndex = clamp(index - 1, 0, this.doc.layers.length - 1)
          this.doc.touch()
        }
      )
    )
  }

  moveLayer(from: number, to: number): void {
    if (from === to) return
    this.doc.moveLayer(from, to)
    this.history.push(
      new ActionCommand(
        'Reorder layer',
        () => this.doc.moveLayer(to, from),
        () => this.doc.moveLayer(from, to)
      )
    )
  }

  selectLayer(index: number): void {
    this.doc.activeIndex = clamp(index, 0, this.doc.layers.length - 1)
    this.contentChanged()
    this.invalidate()
    this.ui.emit()
  }

  /** Live property edits (dragging an opacity slider) skip history; call
   *  `commitLayerProps` once on release if you want it undoable. */
  setLayerProps(index: number, patch: Partial<Pick<Layer, 'name' | 'opacity' | 'blend' | 'visible' | 'locked'>>): void {
    const l = this.doc.layers[index]
    if (!l) return
    Object.assign(l, patch)
    this.doc.touch()
    this.contentChanged()
    this.invalidate()
    this.ui.emit()
  }

  clearLayer(index = this.doc.activeIndex, fillStyle?: string): void {
    const layer = this.doc.layers[index]
    if (!layer) return
    const rect: Rect = { x: 0, y: 0, w: this.doc.width, h: this.doc.height }
    const before = layer.surface.extract(rect)
    if (fillStyle) layer.surface.fill(fillStyle)
    else layer.surface.clear()
    this.doc.touch()
    this.history.push(new PixelPatch(fillStyle ? 'Fill layer' : 'Clear layer', layer, rect, before))
  }

  // ------------------------------------------------------------------ history

  undo(): void {
    this.history.undo()
  }
  redo(): void {
    this.history.redo()
  }

  // ------------------------------------------------------------------- colour

  /** Samples the flattened composite, not the active layer — matches what the
   *  eye sees, which is what "pick this colour" means. */
  pickColor(doc: Pt): string | null {
    const x = Math.round(clamp(doc.x, 0, this.doc.width - 1))
    const y = Math.round(clamp(doc.y, 0, this.doc.height - 1))
    const s = this.compositor.composite(this.doc, null, 1, 'source-over')
    const [r, g, b, a] = s.sample(x, y)
    if (a === 0) return null
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
    this.setBrush({ color: hex })
    return hex
  }

  // ------------------------------------------------------------------- export

  async exportPNG(): Promise<Blob> {
    return this.compositor.flatten(this.doc).toBlob('image/png')
  }

  // -------------------------------------------------------------------- frame

  private frame(): void {
    const now = performance.now()
    if (now - this.frameTime > 500) {
      this.telemetry.fps = Math.round(this.frameCount / ((now - this.frameTime) / 1000))
      this.frameCount = 0
      this.frameTime = now
    }
    if (now - this.sampleTime > 500) {
      this.telemetry.rateHz = Math.round(this.sampleCount / ((now - this.sampleTime) / 1000))
      this.sampleCount = 0
      this.sampleTime = now
    }
    if (now - this.lastTelemetryEmit > 66) {
      this.lastTelemetryEmit = now
      this.telemetryChannel.emit()
    }

    if (!this.needsRender || !this.dsp || !this.display) return
    this.needsRender = false
    this.frameCount++
    this.render(this.dsp)
  }

  private render(g: CanvasRenderingContext2D): void {
    const { camera, doc } = this
    const canvas = this.display!
    const active = this.strokes.active

    // Resolve the live stroke exactly the way endStroke will, so the preview and
    // the committed pixels cannot disagree.
    let strokeSurface: import('./surface').DrawSource | null = null
    let strokeAlpha = 1
    if (active) {
      // One shader pass; the preview is byte-identical to what commit writes.
      this.glStroke.resolve(this.brush.color)
      strokeSurface = this.glStroke
    }
    const composed = this.compositor.composite(
      doc,
      strokeSurface,
      strokeAlpha,
      this.strokes.erasing ? 'destination-out' : 'source-over'
    )

    g.setTransform(1, 0, 0, 1, 0, 0)
    g.fillStyle = '#292929'
    g.fillRect(0, 0, canvas.width, canvas.height)

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.translate(camera.vw / 2, camera.vh / 2)
    g.rotate(camera.rotation)
    g.scale(camera.scale, camera.scale)
    g.translate(-camera.cx, -camera.cy)

    g.save()
    g.shadowColor = 'rgba(0,0,0,.55)'
    g.shadowBlur = 24 / camera.scale
    g.shadowOffsetY = 6 / camera.scale
    g.fillStyle = '#000'
    g.fillRect(0, 0, doc.width, doc.height)
    g.restore()

    const pattern = g.createPattern(this.checker, 'repeat')
    if (pattern) {
      pattern.setTransform(new DOMMatrix().scale(1 / camera.scale))
      g.fillStyle = pattern
      g.fillRect(0, 0, doc.width, doc.height)
    }

    // Mid-stroke the composite changes every frame, so last frame's levels are
    // stale. Only pays the rebuild when actually zoomed out.
    if (active && camera.scale < 0.5) this.mips.invalidate()
    const lvl = this.mips.levelFor(composed.canvas, camera.scale)
    const blit = (): void => {
      g.drawImage(lvl.canvas, 0, 0, lvl.width, lvl.height, 0, 0, doc.width, doc.height)
    }

    const mode = this.canvasScalingMode
    if (camera.scale <= 1) {
      // Shrinking. One bilinear tap cannot represent a 4x reduction, which is
      // what the mip pyramid is for; 'high' is the right filter once the level
      // is close to the target size. See engine/mipmap.ts. 'nearest' is honoured
      // here too, for anyone who wants to see exactly which pixels survived.
      g.imageSmoothingEnabled = mode !== 'nearest'
      g.imageSmoothingQuality = 'high'
      blit()
    } else if (mode === 'smooth' || mode === 'nearest') {
      g.imageSmoothingEnabled = mode === 'smooth'
      g.imageSmoothingQuality = 'low'
      blit()
    } else {
      // 'auto', magnifying. The direction here matters and is easy to get
      // backwards, so, measured in Photoshop, Krita and Clip Studio:
      //
      //   smoothing is ON just above 100% and OFF by about 200%.
      //
      // Which is right. A little past 1:1 nearest is ugly for a different reason
      // than blockiness — a doc pixel covering 1.5 screen pixels gets doubled
      // unevenly, so line weight visibly wobbles. Past 2x there is enough room
      // that exact pixels read as deliberate and smoothing just adds haze.
      //
      // Photoshop and Krita snap at that point; Clip Studio ramps and you can
      // use it for years without noticing, so this ramps: two blits of the same
      // image, the smooth one over the crisp one, its alpha falling to zero as
      // the zoom reaches CRISP_FROM.
      const t = clamp((camera.scale - SMOOTH_UNTIL) / (CRISP_FROM - SMOOTH_UNTIL), 0, 1)
      const smoothMix = 1 - t * t * (3 - 2 * t)
      if (smoothMix < 1) {
        g.imageSmoothingEnabled = false
        blit()
      }
      if (smoothMix > 0) {
        g.save()
        g.globalAlpha = smoothMix
        g.imageSmoothingEnabled = true
        g.imageSmoothingQuality = 'low'
        blit()
        g.restore()
      }
    }

    g.lineWidth = 1 / camera.scale
    g.strokeStyle = 'rgba(255,255,255,.14)'
    g.strokeRect(0, 0, doc.width, doc.height)

    this.drawSymmetryGuides(g)

    // Cursor ring in screen space, so it stays crisp at any zoom.
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.sizePreview.active) {
      this.drawSizePreview(g)
    } else if (this.cursor.visible && this.tool !== 'picker') {
      this.drawCursor(g)
    }
  }

  /**
   * Every style is drawn twice — a dark stroke underneath, a light one on top.
   * A single-colour cursor disappears against paper of the same tone, and the
   * canvas can be any colour at all.
   */
  private drawCursor(g: CanvasRenderingContext2D): void {
    const { x, y } = this.cursor

    if (this.cursorStyle === 'dot') {
      // Snapped to the pixel grid, otherwise a 1px dot antialiases into a
      // smudge and stops being the precise thing it exists to be.
      const px = Math.round(x)
      const py = Math.round(y)
      g.fillStyle = 'rgba(0,0,0,.75)'
      g.fillRect(px - 1, py - 1, 3, 3)
      g.fillStyle = '#fff'
      g.fillRect(px, py, 1, 1)
      return
    }

    if (this.cursorStyle === 'crosshair') {
      const gap = 3
      const arm = 9
      // half-pixel offset keeps 1px lines crisp rather than 2px and grey
      const px = Math.round(x) + 0.5
      const py = Math.round(y) + 0.5
      const pass = (stroke: string, width: number): void => {
        g.strokeStyle = stroke
        g.lineWidth = width
        g.beginPath()
        g.moveTo(px - arm, py)
        g.lineTo(px - gap, py)
        g.moveTo(px + gap, py)
        g.lineTo(px + arm, py)
        g.moveTo(px, py - arm)
        g.lineTo(px, py - gap)
        g.moveTo(px, py + gap)
        g.lineTo(px, py + arm)
        g.stroke()
      }
      pass('rgba(0,0,0,.6)', 3)
      pass('rgba(255,255,255,.9)', 1)
      return
    }

    // 'brush' — outline matching the brush's on-screen size
    const r = Math.max(2.5, this.brush.size * 0.5 * this.camera.scale)
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.strokeStyle = 'rgba(0,0,0,.6)'
    g.lineWidth = 3
    g.stroke()
    g.strokeStyle = 'rgba(255,255,255,.85)'
    g.lineWidth = 1
    g.stroke()
    // A large ring leaves the actual point ambiguous, so mark the centre.
    if (r > 14) {
      g.beginPath()
      g.arc(x, y, 1.2, 0, Math.PI * 2)
      g.fillStyle = 'rgba(255,255,255,.7)'
      g.fill()
    }
  }

  /**
   * Live brush-size preview: the actual tip, at the actual on-screen size, with
   * the actual hardness falloff and colour. Showing a plain outline would hide
   * exactly the thing you are usually trying to judge — how soft the edge is.
   */
  private drawSizePreview(g: CanvasRenderingContext2D): void {
    const { x, y } = this.sizePreview
    const r = Math.max(1, this.brush.size * 0.5 * this.camera.scale)

    g.save()
    g.globalAlpha = 0.85
    const sprite = this.strokes.previewSprite()
    g.drawImage(sprite.canvas, x - r, y - r, r * 2, r * 2)
    g.restore()

    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.strokeStyle = 'rgba(0,0,0,.6)'
    g.lineWidth = 3
    g.stroke()
    g.strokeStyle = 'rgba(255,255,255,.9)'
    g.lineWidth = 1
    g.stroke()

    const size = this.brush.size
    const label = `${size < 10 ? size.toFixed(1) : Math.round(size)} px`
    g.font = '600 12px "Segoe UI", system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const w = g.measureText(label).width + 16
    // Keep the readout on screen when the brush is larger than the viewport.
    const ly = Math.max(14, y - r - 16)
    g.beginPath()
    g.roundRect(x - w / 2, ly - 9, w, 18, 4)
    g.fillStyle = 'rgba(16,17,19,.92)'
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,.2)'
    g.lineWidth = 1
    g.stroke()
    g.fillStyle = '#e6e9ec'
    g.fillText(label, x, ly)
  }

  private drawSymmetryGuides(g: CanvasRenderingContext2D): void {
    const m = this.brush.symmetry
    if (m === 'none') return
    const { width: w, height: h } = this.doc
    g.save()
    g.lineWidth = 1 / this.camera.scale
    g.strokeStyle = 'rgba(110,168,254,.55)'
    g.setLineDash([8 / this.camera.scale, 6 / this.camera.scale])
    g.beginPath()
    if (m === 'x' || m === 'xy') {
      g.moveTo(w / 2, 0)
      g.lineTo(w / 2, h)
    }
    if (m === 'y' || m === 'xy') {
      g.moveTo(0, h / 2)
      g.lineTo(w, h / 2)
    }
    g.stroke()
    g.restore()
  }
}

function makeChecker(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 16
  const x = c.getContext('2d')!
  x.fillStyle = '#2a2d30'
  x.fillRect(0, 0, 16, 16)
  x.fillStyle = '#313539'
  x.fillRect(0, 0, 8, 8)
  x.fillRect(8, 8, 8, 8)
  return c
}

export type { BlendMode }
