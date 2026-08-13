export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One normalised input sample. The brush engine sees nothing else — which is
 *  why the input source (Pointer Events now, Wintab via IPC later) is swappable. */
export interface StrokePoint {
  x: number
  y: number
  /** 0..1 */
  pressure: number
  /** 0 = pen upright, 1 = flat against the surface */
  tilt: number
  /** barrel rotation in radians, 0 if unsupported */
  twist: number
  /** ms, from the event timeline */
  t: number
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
]

export function blendToComposite(b: BlendMode): GlobalCompositeOperation {
  return b === 'normal' ? 'source-over' : (b as GlobalCompositeOperation)
}

export type ToolId =
  | 'brush'
  | 'eraser'
  | 'picker'
  | 'select-rect'
  | 'select-ellipse'
  | 'select-lasso'
  | 'transform'

export const SELECT_TOOLS: readonly ToolId[] = ['select-rect', 'select-ellipse', 'select-lasso']

export function isSelectTool(t: ToolId): boolean {
  return t === 'select-rect' || t === 'select-ellipse' || t === 'select-lasso'
}

export function isPaintTool(t: ToolId): boolean {
  return t === 'brush' || t === 'eraser'
}


/**
 * How the pointer is drawn over the canvas. An app-wide preference rather than
 * a brush setting — it follows the person, not the tool.
 *
 *  brush     — outline circle matching the brush's on-screen size
 *  dot       — a single pixel, for people who want nothing in the way
 *  crosshair — small fixed crosshair, size-independent
 */
export type CursorStyle = 'brush' | 'dot' | 'crosshair'

export const CURSOR_STYLES: CursorStyle[] = ['brush', 'dot', 'crosshair']

/** Display-only sampling used when the document is mapped onto the viewport. */
export type CanvasScalingMode = 'auto' | 'smooth' | 'nearest'

export const CANVAS_SCALING_MODES: CanvasScalingMode[] = ['auto', 'smooth', 'nearest']

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
