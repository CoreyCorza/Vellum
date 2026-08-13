import {
  CANVAS_SCALING_MODES,
  CURSOR_STYLES,
  type CanvasScalingMode,
  type CursorStyle
} from '@engine/types'
import { DEFAULT_BRUSH, type BrushSettings } from '@engine/brush/settings'
import { BUILT_IN_PRESETS, presetSettings, type BrushPreset } from '@engine/brush/presets'

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
  /** Panels the user has closed. Absent means "never chosen", so defaults apply. */
  hiddenPanels?: string[]
  /** Which brush settings category is showing. */
  brushCategory?: string
  /**
   * The measured distortion for this tablet, kept so it survives a restart.
   *
   * Stored as it was fitted rather than recomputed, because fitting it needs a set of ruler
   * sweeps that are not going to be repeated every launch.
   */
  distortion?: unknown
  distortionEnabled?: boolean
  /** The whole shelf, since presets can now be added, renamed and deleted. */
  presets: BrushPreset[]
}

const KEY = 'vellum.prefs'

/**
 * Take a stored value only where it matches the shape of a real brush setting.
 * Stale or hand-edited storage must not be able to feed the dab loop something
 * the engine has no branch for.
 */
/**
 * A stored shelf is only accepted entry by entry. A malformed one falls back to
 * the built-ins rather than leaving the panel empty with no way back.
 */
function sanitisePresets(raw: unknown): BrushPreset[] {
  if (!Array.isArray(raw)) return DEFAULT_PREFS.presets.map((p) => ({ ...p }))
  const out: BrushPreset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    if (typeof o.name !== 'string' || !o.name) continue
    out.push({
      id: o.id,
      name: o.name.slice(0, 48),
      erase: o.erase === true,
      settings: sanitiseBrush(o.settings),
      icon: typeof o.icon === 'string' && o.icon.startsWith('data:image/') ? o.icon : undefined
    })
  }
  return out.length > 0 ? out : DEFAULT_PREFS.presets.map((p) => ({ ...p }))
}

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
  presetTileSize: 48,
  presets: BUILT_IN_PRESETS.map((p) => ({ ...p, settings: presetSettings(p) }))
}

/**
 * A stored correction, checked before it is trusted.
 *
 * It reaches the pen path directly, so a malformed table would either crash a stroke or move
 * every sample by a nonsense amount. Anything unexpected is discarded rather than repaired.
 */
function sanitiseDistortion(v: unknown): unknown {
  if (!v || typeof v !== 'object') return undefined
  const axis = (a: unknown): unknown => {
    if (!a || typeof a !== 'object') return null
    const t = a as Record<string, unknown>
    const nums = (x: unknown): boolean =>
      Array.isArray(x) && x.length > 1 && x.every((n) => typeof n === 'number' && Number.isFinite(n))
    if (typeof t.step !== 'number' || !(t.step > 0)) return null
    if (typeof t.origin !== 'number' || !Number.isFinite(t.origin)) return null
    if (!nums(t.offsets) || !nums(t.weight)) return null
    if ((t.offsets as number[]).length !== (t.weight as number[]).length) return null
    // A correction of more than a few pixels is not a digitiser ripple; it is a bad fit.
    if ((t.offsets as number[]).some((n) => Math.abs(n) > 8)) return null
    return { step: t.step, origin: t.origin, offsets: t.offsets, weight: t.weight }
  }
  const o = v as Record<string, unknown>
  const x = axis(o.x)
  const y = axis(o.y)
  if (!x && !y) return undefined
  return { x, y, note: typeof o.note === 'string' ? o.note : undefined }
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
          : DEFAULT_PREFS.presetTileSize,
      presets: sanitisePresets(parsed.presets),
      hiddenPanels: Array.isArray(parsed.hiddenPanels)
        ? parsed.hiddenPanels.filter((x): x is string => typeof x === 'string')
        : undefined,
      brushCategory: typeof parsed.brushCategory === 'string' ? parsed.brushCategory : undefined,
      distortion: sanitiseDistortion(parsed.distortion),
      distortionEnabled:
        typeof parsed.distortionEnabled === 'boolean' ? parsed.distortionEnabled : undefined
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
