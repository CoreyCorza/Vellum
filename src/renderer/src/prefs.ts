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
  /** The eraser's own preset. Independent of the brush, so it has to be stored. */
  eraserBrush: BrushSettings
  /** Preset shelf: which view, and how big the tiles are in the icon view. */
  presetView: 'list' | 'icons'
  presetTileSize: number
}

const KEY = 'vellum.prefs'

/**
 * Take a stored value only where it matches the shape of a real brush setting.
 * Stale or hand-edited storage must not be able to feed the dab loop something
 * the engine has no branch for.
 */
function sanitiseBrush(raw: unknown): BrushSettings {
  const out = { ...DEFAULT_BRUSH } as unknown as Record<string, unknown>
  if (!raw || typeof raw !== 'object') return out as unknown as BrushSettings
  const ref = DEFAULT_BRUSH as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const want = ref[k]
    if (want === undefined) continue
    if (Array.isArray(want)) {
      const ok =
        Array.isArray(v) &&
        v.length >= 2 &&
        v.every(
          (pt) =>
            pt &&
            typeof (pt as { x: unknown }).x === 'number' &&
            typeof (pt as { y: unknown }).y === 'number'
        )
      if (ok) out[k] = v
      continue
    }
    if (typeof v === typeof want && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v
  }
  return out as unknown as BrushSettings
}

export const DEFAULT_PREFS: Prefs = {
  cursorStyle: 'brush',
  canvasScalingMode: 'auto',
  eraserBrush: { ...DEFAULT_BRUSH },
  presetView: 'list',
  presetTileSize: 48
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
      eraserBrush: sanitiseBrush(parsed.eraserBrush),
      presetView: parsed.presetView === 'icons' ? 'icons' : 'list',
      presetTileSize:
        typeof parsed.presetTileSize === 'number' && Number.isFinite(parsed.presetTileSize)
          ? Math.min(96, Math.max(28, parsed.presetTileSize))
          : DEFAULT_PREFS.presetTileSize
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
