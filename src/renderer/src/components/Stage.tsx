import { useEffect, useRef } from 'react'
import { useEditor } from '../useEditor'
import { bindPointerInput, type Modifiers } from '@engine/input'
import { bindWintabInput, type WintabSample } from '@engine/wintabInput'
import { onWintabSamples, wintabStatus } from '../platform'

export function Stage({ mods }: { mods: Modifiers }): JSX.Element {
  const editor = useEditor()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return

    editor.attach(canvas)
    if (overlayRef.current) editor.attachOverlay(overlayRef.current)

    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect()
      editor.resize(r.width, r.height, window.devicePixelRatio || 1)
      if (!fitted) {
        editor.camera.fit(editor.doc.width, editor.doc.height)
        fitted = true
      }
    })
    let fitted = false
    ro.observe(stage)

    const unbind = bindPointerInput(canvas, editor, mods)

    // Wintab, where available, takes over the pen. Pointer Events keeps mouse
    // and touch either way, so this degrades to the old behaviour on Linux,
    // macOS, in the browser, and on Windows with no tablet driver.
    let unbindWintab: (() => void) | null = null
    let feed: ((samples: WintabSample[]) => void) | null = null
    const debug = import.meta.env.DEV || location.search.includes('debug')

    const attachWintab = (): void => {
      editor.penSource = 'wintab'
      editor.ui.emit()
      unbindWintab = bindWintabInput(canvas, editor, mods, (cb) => {
        feed = cb
        return onWintabSamples(cb)
      })
    }

    void wintabStatus().then((status) => {
      // In debug we attach even without a tablet, purely so the verification
      // scripts can push synthetic packets. Harmless: `wintabRecent` stays
      // false until real samples arrive, so Pointer Events keeps working.
      if (status?.active || debug) attachWintab()
    })

    if (debug) {
      const w = window as unknown as Record<string, unknown>
      w.__wintabFeed = (samples: WintabSample[]): void => feed?.(samples)
      w.__wintabMods = mods
    }

    return () => {
      unbind()
      unbindWintab?.()
      editor.penSource = 'pointer'
      ro.disconnect()
      editor.detach()
    }
    // `mods` is a stable mutable object, deliberately not a dependency —
    // rebinding listeners on every modifier keypress would drop pointer capture
    // mid-stroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  return (
    <div id="stage" ref={stageRef}>
      <canvas id="view" ref={canvasRef} />
      {/* Stacked above the floating panels, so the size ring is not hidden behind
          whichever panel holds the slider being dragged. Never takes a pointer
          event, so it cannot intercept a stroke. */}
      <canvas id="overlay" ref={overlayRef} />
    </div>
  )
}
