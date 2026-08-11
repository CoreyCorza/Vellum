import { CURSOR_STYLES, type CursorStyle } from '@engine/types'

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
}

const KEY = 'inkwell.prefs'

export const DEFAULT_PREFS: Prefs = {
  cursorStyle: 'brush'
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
        : DEFAULT_PREFS.cursorStyle
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
