import {
  CANVAS_SCALING_MODES,
  CURSOR_STYLES,
  type CanvasScalingMode,
  type CursorStyle
} from '@engine/types'
import { DEFAULT_BRUSH, type BrushSettings } from '@engine/brush/settings'

/**
 * App-wide preferences.
 *
 * Deliberately in the renderer, not the engine: the engine holds the *current*
 * value (`editor.cursorStyle`) and knows nothing about where it was stored.
 * That keeps `src/engine` free of platform APIs, which is what lets it run
 * headlessly in the verification scripts.
 */
export interface Prefs {
  cursorStyle: CursorStyle
  canvasScalingMode: CanvasScalingMode
  /**
   * Which settings the eraser holds of its own, and their values.
   *
   * Persisted because an override is a decision, and a decision that quietly
   * evaporates on restart is worse than one that was never offered. Only the
   * overridden keys are stored, so an eraser that has never been touched stays
   * empty and keeps following the brush.
   */
  eraserOverrides: Partial<BrushSettings>
}

const KEY = 'vellum.prefs'

/**
 * Accept only keys that exist on a real brush, with the type the real brush
 * uses. Hand-edited or stale storage must not be able to put a value the engine
 * has no branch for into the dab loop.
 */
function sanitiseOverrides(raw: unknown): Partial<BrushSettings> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, unknown> = {}
  const ref = DEFAULT_BRUSH as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Colour and symmetry are shared with the brush by design, never overridden.
    if (k === 'color' || k === 'symmetry') continue
    const want = ref[k]
    if (want === undefined) continue
    if (Array.isArray(want)) {
      if (
        Array.isArray(v) &&
        v.length >= 2 &&
        v.every((p) => p && typeof (p as { x: unknown }).x === 'number' && typeof (p as { y: unknown }).y === 'number')
      ) {
        out[k] = v
      }
      continue
    }
    if (typeof v === typeof want && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v
  }
  return out as Partial<BrushSettings>
}

export const DEFAULT_PREFS: Prefs = {
  cursorStyle: 'brush',
  canvasScalingMode: 'auto',
  eraserOverrides: {}
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      // Validate rather than trust: a stale or hand-edited value would
      // otherwise put the renderer into a state it has no branch for.
      cursorStyle: CURSOR_STYLES.includes(parsed.cursorStyle as CursorStyle)
        ? (parsed.cursorStyle as CursorStyle)
        : DEFAULT_PREFS.cursorStyle,
      canvasScalingMode: CANVAS_SCALING_MODES.includes(
        parsed.canvasScalingMode as CanvasScalingMode
      )
        ? (parsed.canvasScalingMode as CanvasScalingMode)
        : DEFAULT_PREFS.canvasScalingMode,
      eraserOverrides: sanitiseOverrides(parsed.eraserOverrides)
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(patch: Partial<Prefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {
    /* private mode, quota — not worth failing a paint app over */
  }
}
