import type { Editor } from './editor'
import type { StrokePoint } from './types'
import { clamp } from './types'
import { decideIntent, overCanvas, type Intent, type Modifiers } from './gestures'

/** Mirrors `WintabSample` in the main process. Coordinates are viewport CSS
 *  pixels, the same units a PointerEvent's clientX/clientY carries. */
export interface WintabSample {
  t: number
  x: number
  y: number
  pressure: number
  buttons: number
  tilt: number
  twist: number
  inverted: boolean
}

/** Wintab button bit 0 is the tip switch. */
const TIP = 0x01
/** Bit 1 is the lower barrel button on essentially every driver. */
export const BARREL_LOWER = 0x02
export const BARREL_UPPER = 0x04

/**
 * Drives the editor from Wintab packets.
 *
 * The payoff of keeping the brush engine behind `StrokePoint`: the spline, the
 * stabiliser, the spacing walk and the wash buffer are all reused untouched.
 * Only the numbers' origin changes — and they now arrive at the digitiser's
 * full resolution rather than WM_POINTER's 1024 pressure steps.
 *
 * Gesture decisions come from `gestures.ts`, shared with the Pointer Events
 * path. Wintab hands us bare screen coordinates: no DOM targeting, no modifier
 * state. Deciding here independently is how this path first shipped painting
 * underneath floating panels and ignoring every drag shortcut.
 */
export function bindWintabInput(
  canvas: HTMLCanvasElement,
  editor: Editor,
  mods: Modifiers,
  subscribe: (cb: (samples: WintabSample[]) => void) => () => void
): () => void {
  let rect = canvas.getBoundingClientRect()
  const refreshRect = (): void => {
    rect = canvas.getBoundingClientRect()
  }

  /** Shared with the Pointer Events path — see Editor.nav. */
  const nav = editor.nav
  let tipDown = false
  let barrelDown = false
  /** Latched at press time and held for the whole press, so moving over a
   *  panel mid-stroke does not change what the gesture is. */
  let intent: Intent = 'ignore'

  const toStrokePoint = (s: WintabSample, lx: number, ly: number): StrokePoint => {
    const doc = editor.camera.screenToDoc(lx, ly)
    return {
      x: doc.x,
      y: doc.y,
      // Some drivers report 0 at first contact; the floor keeps the opening dab
      // from vanishing without inventing pressure.
      pressure: clamp(s.pressure > 0 ? s.pressure : 0.001, 0, 1),
      tilt: clamp(s.tilt, 0, 1),
      twist: s.twist,
      t: s.t
    }
  }

  const beginPress = (s: WintabSample, lx: number, ly: number, secondary: boolean): void => {
    intent = decideIntent({
      mods,
      alt: mods.alt,
      ctrl: mods.ctrl,
      shift: false, // Wintab carries no keyboard shift; tracked mods cover the rest
      primary: !secondary,
      middle: false,
      secondary,
      tool: editor.tool,
      overCanvas: overCanvas(canvas, s.x, s.y),
      scrubActive: editor.sizeScrubActive
    })

    switch (intent) {
      case 'pan':
        nav.beginPan(s.x, s.y, false)
        break
      case 'rotate':
        nav.beginPan(s.x, s.y, true)
        break
      case 'zoom':
        nav.beginZoom(editor, { x: lx, y: ly }, s.y)
        break
      case 'sizeScrub':
        editor.beginSizeScrub(lx, ly, 'pointer')
        break
      case 'pick':
        editor.pickColor(editor.camera.screenToDoc(lx, ly))
        if (editor.tool === 'picker') editor.setTool('brush')
        break
      case 'paint':
        editor.beginStroke(toStrokePoint(s, lx, ly), s.inverted || editor.tool === 'eraser')
        break
      case 'ignore':
      default:
        break
    }
  }

  const endPress = (): void => {
    if (intent === 'paint' && editor.strokeActive) editor.endStroke()
    if (intent === 'sizeScrub') editor.endSizeScrub('pointer')
    nav.end()
    intent = 'ignore'
  }

  const onSamples = (samples: WintabSample[]): void => {
    if (samples.length === 0) return
    // Claim the pen before anything else — this is what tells the Pointer
    // Events layer to stand down for the next 250 ms.
    editor.lastWintabAt = performance.now()
    refreshRect()

    for (const s of samples) {
      const lx = s.x - rect.left
      const ly = s.y - rect.top
      const down = (s.buttons & TIP) !== 0
      const barrel = (s.buttons & BARREL_LOWER) !== 0

      editor.cursor.x = lx
      editor.cursor.y = ly
      editor.cursor.visible = overCanvas(canvas, s.x, s.y)

      const t = editor.telemetry
      t.pointerType = 'wintab'
      t.pressure = s.pressure
      t.tiltX = Math.round(s.tilt * 90)
      t.tiltY = 0
      t.twist = Math.round((s.twist * 180) / Math.PI)
      const doc = editor.camera.screenToDoc(lx, ly)
      t.docX = doc.x
      t.docY = doc.y

      // --- barrel button, independent of the tip -----------------------------
      if (barrel && !barrelDown) {
        barrelDown = true
        if (!tipDown) beginPress(s, lx, ly, true)
      } else if (!barrel && barrelDown) {
        barrelDown = false
        if (!tipDown) endPress()
      }

      // --- tip switch --------------------------------------------------------
      if (down && !tipDown) {
        tipDown = true
        if (!barrelDown) beginPress(s, lx, ly, false)
      } else if (!down && tipDown) {
        tipDown = false
        if (!barrelDown) endPress()
      }

      // --- continue whatever the press started -------------------------------
      if (tipDown || barrelDown) {
        if (intent === 'paint') {
          if (editor.strokeActive) editor.extendStroke(toStrokePoint(s, lx, ly))
        } else if (intent === 'sizeScrub') {
          editor.updateSizeScrub(lx)
        } else {
          nav.move(editor, s.x, s.y)
        }
      } else if (editor.sizeScrubActive) {
        // key-driven scrub (hold S) tracks a hovering pen too
        editor.updateSizeScrub(lx)
      }
    }
    editor.invalidate()
  }

  const unsubscribe = subscribe(onSamples)
  window.addEventListener('resize', refreshRect)
  window.addEventListener('scroll', refreshRect, true)

  return () => {
    unsubscribe()
    window.removeEventListener('resize', refreshRect)
    window.removeEventListener('scroll', refreshRect, true)
    if (editor.strokeActive) editor.endStroke()
  }
}
