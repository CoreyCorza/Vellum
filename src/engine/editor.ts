import { PaintDocument, Layer } from './document'
import { Surface } from './surface'
import { Camera } from './camera'
import { Compositor } from './compositor'
import { History, PixelPatch, ActionCommand, CompoundCommand } from './history'
import {
  Selection,
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  normalisedRect,
  unionRect,
  type PixelTransform,
  type SelectionSnapshot
} from './selection'
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
import { clamp, isPaintTool, isSelectTool } from './types'
import { rectIsEmpty } from './bounds'
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
  readonly selection: Selection

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

  private selDrag: SelectDrag | null = null
  private xfDrag: TransformDrag | null = null
  private xfSelBefore: SelectionSnapshot | null = null
  private xfStartRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private xfDirty = false

  private display: HTMLCanvasElement | null = null
  private dsp: CanvasRenderingContext2D | null = null
  /**
   * A transparent canvas stacked above the floating panels.
   *
   * The size ring was drawn into the main canvas, which sits UNDER the panels — so
   * the ring appeared behind whichever panel held the slider being dragged, which is
   * exactly where you are looking. It has to be drawn above everything, and it has
   * to be a canvas rather than a styled div so it can keep using the brush's real
   * tip sprite instead of a CSS gradient that would drift from it.
   */
  private overlay: HTMLCanvasElement | null = null
  private ovl: CanvasRenderingContext2D | null = null
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
  /**
   * `label` is false when a slider opened the ring: that slider is already showing
   * the number, right where the pointer is, and two readouts for one value is
   * clutter. The Alt+RMB scrub keeps it, because there may be no panel open at all.
   */
  brushPreview = { active: false, x: 0, y: 0, label: true }
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
    this.selection = new Selection(width, height)
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

  attachOverlay(canvas: HTMLCanvasElement): void {
    this.overlay = canvas
    this.ovl = canvas.getContext('2d')
    this.sizeOverlay()
  }

  detach(): void {
    cancelAnimationFrame(this.rafId)
    this.display = null
    this.dsp = null
    this.overlay = null
    this.ovl = null
  }

  private sizeOverlay(): void {
    const o = this.overlay
    if (!o) return
    o.width = Math.max(1, Math.round(this.camera.vw * this.dpr))
    o.height = Math.max(1, Math.round(this.camera.vh * this.dpr))
    o.style.width = `${this.camera.vw}px`
    o.style.height = `${this.camera.vh}px`
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    if (!this.display) return
    this.dpr = Math.min(dpr, 2)
    this.camera.setViewport(cssW, cssH)
    this.display.width = Math.max(1, Math.round(cssW * this.dpr))
    this.display.height = Math.max(1, Math.round(cssH * this.dpr))
    this.sizeOverlay()
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
   * Show the brush preview without arming a scrub.
   *
   * Dragging a slider changes a number, and neither "34 px" nor "30%" is something
   * anyone can picture — they mean nothing until you have drawn with them. The
   * preview is the mark itself: size from the ring, density and edge from the dab.
   * Both the size and opacity sliders open it, which is why it is not called a size
   * preview any more.
   */
  showBrushPreview(x?: number, y?: number): void {
    // Where you last had the pen, falling back to the middle of the viewport. The
    // last position is the better default: it is the part of the drawing you were
    // working on, so the ring appears in context rather than over a panel.
    const seen = this.cursor.x > -9000 && this.cursor.y > -9000
    this.brushPreview.active = true
    this.brushPreview.label = false
    this.brushPreview.x = x ?? (seen ? this.cursor.x : this.camera.vw / 2)
    this.brushPreview.y = y ?? (seen ? this.cursor.y : this.camera.vh / 2)
    this.invalidate()
  }

  hideBrushPreview(): void {
    if (!this.brushPreview.active) return
    this.brushPreview.active = false
    this.invalidate()
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
  beginSizeScrub(x: number, y: number, source: ScrubSource): void {
    this.brushPreview.label = true
    if (this.scrub) return
    this.scrub = { originX: x, startSize: this.brush.size, source }
    this.brushPreview.active = true
    this.brushPreview.x = x
    this.brushPreview.y = y
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
    this.brushPreview.active = false
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
      if (this.selection.active) this.selection.applySymmetry(patch.symmetry)
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
      this.camera.scale,
      this.selection.active ? this.selection.rect : null
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
      const clip = this.selection.active ? this.selection.mask : null
      layer.surface.draw(this.glStroke, 1, op, rect, clip)
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


  // -------------------------------------------------------------- selection

  get selectionActive(): boolean {
    return this.selection.active
  }

  get selectGestureActive(): boolean {
    return this.selDrag !== null
  }

  get transformGestureActive(): boolean {
    return this.xfDrag !== null
  }

  selectRect(x: number, y: number, w: number, h: number): void {
    const before = this.selection.snapshot()
    this.selection.setRect(x, y, w, h, this.brush.symmetry)
    this.pushSelectionHistory('Select', before)
  }

  selectEllipse(x: number, y: number, w: number, h: number): void {
    const before = this.selection.snapshot()
    this.selection.setEllipse(x, y, w, h, this.brush.symmetry)
    this.pushSelectionHistory('Select', before)
  }

  selectLasso(points: readonly Pt[]): void {
    const before = this.selection.snapshot()
    this.selection.setLasso(points, this.brush.symmetry)
    this.pushSelectionHistory('Select', before)
  }

  selectAll(): void {
    const before = this.selection.snapshot()
    this.selection.selectAll()
    this.pushSelectionHistory('Select all', before)
  }

  deselect(): void {
    if (!this.selection.active && !this.selDrag) return
    this.selDrag = null
    const before = this.selection.snapshot()
    this.selection.clear()
    this.pushSelectionHistory('Deselect', before)
  }

  beginSelect(doc: Pt): void {
    if (!isSelectTool(this.tool)) return
    this.selDrag = {
      mode: this.tool,
      origin: { x: doc.x, y: doc.y },
      current: { x: doc.x, y: doc.y },
      points: [{ x: doc.x, y: doc.y }]
    }
    this.invalidate()
  }

  extendSelect(doc: Pt): void {
    const d = this.selDrag
    if (!d) return
    d.current = { x: doc.x, y: doc.y }
    if (d.mode === 'select-lasso') d.points.push({ x: doc.x, y: doc.y })
    this.invalidate()
  }

  endSelect(): void {
    const d = this.selDrag
    if (!d) return
    this.selDrag = null
    if (d.mode === 'select-lasso') {
      if (d.points.length < 3) {
        this.invalidate()
        return
      }
      this.selectLasso(d.points)
      return
    }
    const r = normalisedRect(d.origin.x, d.origin.y, d.current.x - d.origin.x, d.current.y - d.origin.y)
    if (r.w < 2 && r.h < 2) {
      this.deselect()
      return
    }
    if (d.mode === 'select-ellipse') this.selectEllipse(r.x, r.y, r.w, r.h)
    else this.selectRect(r.x, r.y, r.w, r.h)
  }

  beginTransform(doc: Pt): void {
    if (this.tool !== 'transform') return
    if (!this.selection.active) return
    const layer = this.doc.active
    if (layer.locked) return
    const aabb = this.selection.rect
    const handle = hitTransformHandle(doc, aabb, this.camera.scale)
    if (!handle) {
      this.deselect()
      return
    }
    this.backup.copyFrom(layer.surface)
    this.xfSelBefore = this.selection.snapshot()
    this.xfStartRect = { ...aabb }
    const cx = this.doc.width / 2
    const cy = this.doc.height / 2
    const mode = this.brush.symmetry
    this.xfDirty = false
    this.xfDrag = {
      handle,
      start: { x: doc.x, y: doc.y },
      aabb,
      flipX: (mode === 'x' || mode === 'xy') && doc.x > cx,
      flipY: (mode === 'y' || mode === 'xy') && doc.y > cy
    }
    this.invalidate()
  }

  extendTransform(doc: Pt): void {
    const xf = this.xfDrag
    const before = this.xfSelBefore
    if (!xf || !before) return
    const layer = this.doc.active
    layer.surface.copyFrom(this.backup)
    this.selection.restore(before)
    const t = transformFromDrag(xf, doc)
    if (!isIdentityTransform(t)) {
      this.selection.transform(layer.surface, t, this.brush.symmetry)
      this.xfDirty = true
    }
    this.contentChanged()
    this.invalidate()
  }

  endTransform(): void {
    const xf = this.xfDrag
    const selBefore = this.xfSelBefore
    if (!xf || !selBefore) return
    this.xfDrag = null
    this.xfSelBefore = null
    const layer = this.doc.active
    if (!this.xfDirty) {
      this.invalidate()
      return
    }
    this.xfDirty = false
    const afterRect = this.selection.rect
    const union = padRect(unionRect(this.xfStartRect, afterRect), this.doc.width, this.doc.height, 2)
    if (rectIsEmpty(union)) {
      this.contentChanged()
      this.invalidate()
      this.ui.emit()
      return
    }
    const beforePix = this.backup.extract(union)
    const selAfter = this.selection.snapshot()
    this.history.push(
      new CompoundCommand('Transform', [
        new PixelPatch('Transform', layer, union, beforePix),
        this.makeSelCommand('Transform selection', selBefore, selAfter)
      ])
    )
    this.contentChanged()
    this.invalidate()
    this.ui.emit()
  }

  /** Translate selected pixels. With symmetry, the other side(s) move as mirrors. */
  moveSelection(dx: number, dy: number): void {
    this.commitTransform({ ...IDENTITY_TRANSFORM, dx, dy })
  }

  /** Scale selected pixels about (ox, oy), defaulting to the selection centre. */
  scaleSelection(sx: number, sy: number, ox?: number, oy?: number): void {
    const r = this.selection.rect
    this.commitTransform({
      dx: 0,
      dy: 0,
      sx,
      sy,
      ox: ox ?? r.x + r.w / 2,
      oy: oy ?? r.y + r.h / 2
    })
  }

  /** Escape: cancel an in-flight gesture, otherwise deselect. */
  cancelSelectionGesture(): void {
    if (this.selDrag) {
      this.selDrag = null
      this.invalidate()
      return
    }
    if (this.xfDrag && this.xfSelBefore) {
      this.doc.active.surface.copyFrom(this.backup)
      this.selection.restore(this.xfSelBefore)
      this.xfDrag = null
      this.xfSelBefore = null
      this.contentChanged()
      this.invalidate()
      this.ui.emit()
      return
    }
    this.deselect()
  }

  private commitTransform(t: PixelTransform): void {
    if (!this.selection.active || isIdentityTransform(t)) return
    const layer = this.doc.active
    if (layer.locked) return
    const beforeRect = this.selection.rect
    const afterRect = this.selection.boundsAfter(t, this.brush.symmetry)
    const union = padRect(unionRect(beforeRect, afterRect), this.doc.width, this.doc.height, 2)
    if (rectIsEmpty(union)) return
    const beforePix = layer.surface.extract(union)
    const selBefore = this.selection.snapshot()
    this.selection.transform(layer.surface, t, this.brush.symmetry)
    const selAfter = this.selection.snapshot()
    this.history.push(
      new CompoundCommand('Transform', [
        new PixelPatch('Transform', layer, union, beforePix),
        this.makeSelCommand('Transform selection', selBefore, selAfter)
      ])
    )
    this.contentChanged()
    this.invalidate()
    this.ui.emit()
  }

  private pushSelectionHistory(label: string, before: SelectionSnapshot): void {
    const after = this.selection.snapshot()
    if (!before.active && !after.active) {
      this.invalidate()
      this.ui.emit()
      return
    }
    this.history.push(this.makeSelCommand(label, before, after))
    this.invalidate()
    this.ui.emit()
  }

  private makeSelCommand(
    label: string,
    before: SelectionSnapshot,
    after: SelectionSnapshot
  ): ActionCommand {
    const bytes =
      (before.mask ? before.mask.width * before.mask.height * 4 : 0) +
      (after.mask ? after.mask.width * after.mask.height * 4 : 0)
    return new ActionCommand(
      label,
      () => {
        this.selection.restore(before)
        this.invalidate()
        this.ui.emit()
      },
      () => {
        this.selection.restore(after)
        this.invalidate()
        this.ui.emit()
      },
      bytes
    )
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
      this.strokes.erasing ? 'destination-out' : 'source-over',
      this.selection.active ? this.selection.mask : null
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
    this.drawSelection(g)

    // Cursor ring in screen space, so it stays crisp at any zoom. The size ring is
    // NOT drawn here — it goes on the overlay, above the panels.
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (
      !this.brushPreview.active &&
      this.cursor.visible &&
      isPaintTool(this.tool)
    ) {
      this.drawCursor(g)
    }

    this.renderOverlay()
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
  private drawBrushPreview(g: CanvasRenderingContext2D): void {
    const { x, y } = this.brushPreview
    const r = Math.max(1, this.brush.size * 0.5 * this.camera.scale)

    // The brush's real tip at the brush's real opacity: the dab shows density and
    // softness, the ring shows size. One preview answers both sliders, and neither
    // number has to be pictured from a percentage or a pixel count.
    //
    // Drawn at the true opacity rather than a fixed 0.85, so a 10% brush previews
    // as a 10% mark. At very low values the dab nearly vanishes — which is the
    // honest answer, and the ring is still there to carry the size.
    g.save()
    g.globalAlpha = clamp(this.brush.opacity, 0.02, 1)
    g.drawImage(this.strokes.previewSprite().canvas, x - r, y - r, r * 2, r * 2)
    g.restore()

    // Twice, dark then light: one colour vanishes against paper of the same tone.
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.strokeStyle = 'rgba(0,0,0,.6)'
    g.lineWidth = 3
    g.stroke()
    g.strokeStyle = 'rgba(255,255,255,.9)'
    g.lineWidth = 1
    g.stroke()

    // A slider opened this, and that slider is already showing the number right
    // under the pointer. Two readouts for one value is clutter.
    if (!this.brushPreview.label) return

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

  /**
   * The overlay pass: everything that must appear ABOVE the floating panels.
   *
   * Only the size ring, for now. Cleared every frame it is not needed, which is
   * cheap on a canvas this size and means nothing can be left behind.
   */
  private renderOverlay(): void {
    const g = this.ovl
    const o = this.overlay
    if (!g || !o) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, o.width, o.height)
    if (!this.brushPreview.active) return
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.drawBrushPreview(g)
  }



  private drawSelection(g: CanvasRenderingContext2D): void {
    const scale = this.camera.scale
    const lw = 1 / scale
    const mode = this.brush.symmetry
    const { width: w, height: h } = this.doc

    if (this.selection.active) {
      g.save()
      g.globalAlpha = 0.22
      g.drawImage(this.selection.mask.canvas, 0, 0)
      g.restore()
      const r = this.selection.rect
      if (!rectIsEmpty(r)) {
        strokeMarchingRect(g, r, lw)
        if (this.tool === 'transform' || this.xfDrag) drawTransformHandles(g, r, lw)
      }
    }

    const d = this.selDrag
    if (d) {
      g.save()
      g.lineWidth = lw
      g.strokeStyle = 'rgba(255,255,255,.9)'
      g.setLineDash([4 / scale, 4 / scale])
      const drawShape = (): void => {
        if (d.mode === 'select-lasso') {
          if (d.points.length < 1) return
          g.beginPath()
          g.moveTo(d.points[0].x, d.points[0].y)
          for (let i = 1; i < d.points.length; i++) g.lineTo(d.points[i].x, d.points[i].y)
          g.stroke()
          return
        }
        const r = normalisedRect(
          d.origin.x,
          d.origin.y,
          d.current.x - d.origin.x,
          d.current.y - d.origin.y
        )
        g.beginPath()
        if (d.mode === 'select-ellipse') {
          g.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2)
        } else {
          g.rect(r.x, r.y, r.w, r.h)
        }
        g.stroke()
      }
      drawShape()
      if (mode === 'x' || mode === 'xy') {
        g.save()
        g.translate(w, 0)
        g.scale(-1, 1)
        drawShape()
        g.restore()
      }
      if (mode === 'y' || mode === 'xy') {
        g.save()
        g.translate(0, h)
        g.scale(1, -1)
        drawShape()
        g.restore()
      }
      if (mode === 'xy') {
        g.save()
        g.translate(w, h)
        g.scale(-1, -1)
        drawShape()
        g.restore()
      }
      g.restore()
    }
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


type SelectDrag = {
  mode: ToolId
  origin: Pt
  current: Pt
  points: Pt[]
}

type TransformHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type TransformDrag = {
  handle: TransformHandle
  start: Pt
  aabb: Rect
  flipX: boolean
  flipY: boolean
}

function padRect(r: Rect, maxW: number, maxH: number, pad: number): Rect {
  const x = clamp(Math.floor(r.x) - pad, 0, maxW)
  const y = clamp(Math.floor(r.y) - pad, 0, maxH)
  const x2 = clamp(Math.ceil(r.x + r.w) + pad, 0, maxW)
  const y2 = clamp(Math.ceil(r.y + r.h) + pad, 0, maxH)
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) }
}

function hitTransformHandle(doc: Pt, aabb: Rect, scale: number): TransformHandle | null {
  const rad = 8 / scale
  const pts: [TransformHandle, number, number][] = [
    ['nw', aabb.x, aabb.y],
    ['n', aabb.x + aabb.w / 2, aabb.y],
    ['ne', aabb.x + aabb.w, aabb.y],
    ['e', aabb.x + aabb.w, aabb.y + aabb.h / 2],
    ['se', aabb.x + aabb.w, aabb.y + aabb.h],
    ['s', aabb.x + aabb.w / 2, aabb.y + aabb.h],
    ['sw', aabb.x, aabb.y + aabb.h],
    ['w', aabb.x, aabb.y + aabb.h / 2]
  ]
  for (const [name, x, y] of pts) {
    if (Math.hypot(doc.x - x, doc.y - y) <= rad) return name
  }
  if (
    doc.x >= aabb.x &&
    doc.x <= aabb.x + aabb.w &&
    doc.y >= aabb.y &&
    doc.y <= aabb.y + aabb.h
  ) {
    return 'move'
  }
  return null
}

function transformFromDrag(xf: TransformDrag, doc: Pt): PixelTransform {
  const rawDx = doc.x - xf.start.x
  const rawDy = doc.y - xf.start.y
  if (xf.handle === 'move') {
    return {
      dx: xf.flipX ? -rawDx : rawDx,
      dy: xf.flipY ? -rawDy : rawDy,
      sx: 1,
      sy: 1,
      ox: 0,
      oy: 0
    }
  }
  const ox = xf.aabb.x + xf.aabb.w / 2
  const oy = xf.aabb.y + xf.aabb.h / 2
  const hw = Math.max(1e-3, xf.aabb.w / 2)
  const hh = Math.max(1e-3, xf.aabb.h / 2)
  let sx = 1
  let sy = 1
  const h = xf.handle
  if (h === 'e' || h === 'w' || h === 'ne' || h === 'se' || h === 'nw' || h === 'sw') {
    sx = clamp(Math.abs(doc.x - ox) / hw, 0.05, 32)
  }
  if (h === 'n' || h === 's' || h === 'ne' || h === 'se' || h === 'nw' || h === 'sw') {
    sy = clamp(Math.abs(doc.y - oy) / hh, 0.05, 32)
  }
  return { dx: 0, dy: 0, sx, sy, ox, oy }
}

function strokeMarchingRect(g: CanvasRenderingContext2D, r: Rect, lw: number): void {
  g.save()
  g.lineWidth = lw
  g.setLineDash([4 * lw, 4 * lw])
  g.strokeStyle = 'rgba(0,0,0,.7)'
  g.strokeRect(r.x, r.y, r.w, r.h)
  g.lineDashOffset = 4 * lw
  g.strokeStyle = 'rgba(255,255,255,.9)'
  g.strokeRect(r.x, r.y, r.w, r.h)
  g.restore()
}

function drawTransformHandles(g: CanvasRenderingContext2D, r: Rect, lw: number): void {
  const s = Math.max(6 * lw, lw * 6)
  const pts = [
    [r.x, r.y],
    [r.x + r.w / 2, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h / 2],
    [r.x + r.w, r.y + r.h],
    [r.x + r.w / 2, r.y + r.h],
    [r.x, r.y + r.h],
    [r.x, r.y + r.h / 2]
  ]
  g.save()
  g.lineWidth = lw
  g.fillStyle = '#fff'
  g.strokeStyle = 'rgba(0,0,0,.7)'
  for (const [x, y] of pts) {
    g.beginPath()
    g.rect(x - s / 2, y - s / 2, s, s)
    g.fill()
    g.stroke()
  }
  g.restore()
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
