import type { Editor } from './editor'
import type { Pt, ToolId } from './types'
import { clamp } from './types'
import { MAX_ZOOM, MIN_ZOOM } from './camera'

export interface Modifiers {
  space: boolean
  alt: boolean
  ctrl: boolean
}

/**
 * What a press should do.
 *
 * Shared by both input sources on purpose. Pointer Events gets modifier state
 * and DOM hit-testing for free; Wintab gets neither — it receives bare screen
 * coordinates from the driver. Reimplementing this per source is exactly how
 * the Wintab path ended up painting underneath floating panels and ignoring
 * space-to-pan.
 */
export type Intent = 'pan' | 'rotate' | 'zoom' | 'sizeScrub' | 'pick' | 'paint' | 'ignore'

export interface IntentInput {
  mods: Modifiers
  /** modifier state carried by the event itself, which beats tracked state */
  alt: boolean
  ctrl: boolean
  shift: boolean
  primary: boolean
  middle: boolean
  secondary: boolean
  tool: ToolId
  /** false when a panel or other UI is under the pen */
  overCanvas: boolean
  scrubActive: boolean
}

export function decideIntent(i: IntentInput): Intent {
  if (!i.overCanvas) return 'ignore'
  if (i.scrubActive) return 'ignore'
  if (i.secondary && i.alt) return 'sizeScrub'
  if (i.primary && i.mods.space && i.ctrl) return 'zoom'
  if (i.middle && i.shift) return 'rotate'
  if (i.middle || i.secondary || i.mods.space) return 'pan'
  if (i.tool === 'picker' || i.alt) return 'pick'
  return 'paint'
}

/**
 * True when the topmost element at these viewport coordinates is the canvas.
 *
 * Pointer Events gets this from DOM dispatch. Wintab has to ask, because the
 * floating panels sit above a full-bleed canvas — geometrically every point is
 * "inside" it.
 */
export function overCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
  return document.elementFromPoint(clientX, clientY) === canvas
}

/**
 * Pan / rotate / scrubby-zoom drag state, shared by both input sources.
 * Coordinates are viewport CSS pixels throughout.
 */
export class NavDrag {
  private pan: { x: number; y: number; rotate: boolean } | null = null
  private zoom: { originY: number; startScale: number; screen: Pt; doc: Pt } | null = null

  get active(): boolean {
    return this.pan !== null || this.zoom !== null
  }

  beginPan(clientX: number, clientY: number, rotate: boolean): void {
    this.pan = { x: clientX, y: clientY, rotate }
  }

  beginZoom(editor: Editor, local: Pt, clientY: number): void {
    this.zoom = {
      originY: clientY,
      startScale: editor.camera.scale,
      screen: local,
      doc: editor.camera.screenToDoc(local.x, local.y)
    }
  }

  /** Diagnostics: total input travel vs resulting on-screen document travel.
   *  A healthy pan keeps these equal — see scripts/diagnose-pan.cjs. */
  debugInputTravel = 0
  debugDocTravel = 0

  move(editor: Editor, clientX: number, clientY: number): boolean {
    if (this.pan) {
      this.debugInputTravel += Math.hypot(clientX - this.pan.x, clientY - this.pan.y)
      const beforeX = editor.camera.cx
      const beforeY = editor.camera.cy
      queueMicrotask(() => {
        this.debugDocTravel +=
          Math.hypot(editor.camera.cx - beforeX, editor.camera.cy - beforeY) *
          editor.camera.scale
      })
    }
    if (this.pan) {
      const dx = clientX - this.pan.x
      const dy = clientY - this.pan.y
      this.pan.x = clientX
      this.pan.y = clientY
      if (this.pan.rotate) editor.camera.rotation += dx * 0.006
      else editor.camera.panBy(dx, dy)
      editor.invalidate()
      return true
    }
    if (this.zoom) {
      // Exponential, so each pixel is a constant ratio and the gesture feels
      // the same at 10% or 800%.
      const dy = clientY - this.zoom.originY
      editor.camera.scale = clamp(
        this.zoom.startScale * Math.exp(-dy * 0.008),
        MIN_ZOOM,
        MAX_ZOOM
      )
      editor.camera.anchor(this.zoom.doc, this.zoom.screen)
      editor.invalidate()
      return true
    }
    return false
  }

  end(): void {
    this.pan = null
    this.zoom = null
  }
}
