import type { Editor } from './editor'
import type { Pt, StrokePoint } from './types'
import { clamp } from './types'

export type { Modifiers } from './gestures'

/**
 * Translates DOM pointer events into `StrokePoint`s.
 *
 * Everything platform-shaped lives here and nowhere else — coalesced samples,
 * palm rejection, the inverted-pen eraser, barrel-button panning, pinch
 * gestures. If pressure ever has to come from Wintab over IPC instead, this is
 * the only file that changes; the brush engine consumes `StrokePoint` and has
 * no idea where it came from.
 */
export function bindPointerInput(
  canvas: HTMLCanvasElement,
  editor: Editor,
  mods: import('./gestures').Modifiers
): () => void {
  let rect = canvas.getBoundingClientRect()
  const refreshRect = (): void => {
    rect = canvas.getBoundingClientRect()
  }

  /** Once a pen has been seen, touch navigates but never paints. Palm rejection
   *  for free, and the reason resting your hand on the tablet is safe. */
  let penSeen = false
  let strokePointerId = -1
  /** Shared with every other input path — see Editor.nav. */
  const nav = editor.nav

  const touches = new Map<number, Pt>()
  let gesture: {
    dist: number
    angle: number
    scale: number
    rotation: number
    doc: Pt
  } | null = null

  /** pointerrawupdate arrives ahead of pointermove with the same coalesced
   *  payload, so we prefer it — but only while it is actually arriving. The
   *  timeout means a device that emits only pointermove still works instead of
   *  going silently dead. */
  let lastRawUpdate = -Infinity

  const local = (e: { clientX: number; clientY: number }): Pt => ({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  })

  const toStrokePoint = (e: PointerEvent): StrokePoint => {
    const p = local(e)
    const doc = editor.camera.screenToDoc(p.x, p.y)
    const tiltX = e.tiltX || 0
    const tiltY = e.tiltY || 0
    let pressure: number
    if (e.pointerType === 'pen') {
      pressure = clamp(e.pressure > 0 ? e.pressure : 0.001, 0, 1)
    } else {
      pressure = 1
    }
    return {
      x: doc.x,
      y: doc.y,
      pressure,
      tilt: clamp(Math.hypot(tiltX, tiltY) / 90, 0, 1),
      twist: ((e.twist || 0) * Math.PI) / 180,
      t: e.timeStamp
    }
  }

  const updateTelemetry = (e: PointerEvent): void => {
    const p = local(e)
    const doc = editor.camera.screenToDoc(p.x, p.y)
    const t = editor.telemetry
    t.pointerType = e.pointerType
    t.pressure = e.pointerType === 'pen' ? e.pressure : editor.strokeActive ? 1 : 0
    t.tiltX = e.tiltX || 0
    t.tiltY = e.tiltY || 0
    t.twist = e.twist || 0
    t.docX = doc.x
    t.docY = doc.y
  }

  const onPointerDown = (e: PointerEvent): void => {
    refreshRect()
    if (e.pointerType === 'pen') penSeen = true
    // Wintab owns the pen while it is reporting. Note this catches
    // pointerType 'mouse' too: with Windows Ink off the tablet drives the
    // system cursor, so the stylus arrives here disguised as a mouse.
    if (editor.wintabRecent) return
    canvas.setPointerCapture(e.pointerId)

    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size >= 2) {
        editor.cancelStroke()
        startGesture()
        return
      }
      if (penSeen) {
        nav.beginPan(e.clientX, e.clientY, false)
        return
      }
    }

    const p = local(e)
    const doc = editor.camera.screenToDoc(p.x, p.y)
    // Barrel button and right mouse button are the same signal here.
    const rightButton = e.button === 2 || (e.buttons & 2) !== 0

    // Prefer the event's own modifier state over our keyboard-tracked flags.
    // The event is authoritative at the instant of the click; the tracked flag
    // can be stale if a keyup was swallowed (alt-tab, focus change), which would
    // silently turn a resize into a pan. Space has no event property, so it has
    // to come from tracking.
    const alt = e.altKey || mods.alt
    const ctrl = e.ctrlKey || mods.ctrl

    // A key-driven size scrub is already running — swallow the press so it
    // cannot paint or pan underneath the gesture.
    if (editor.sizeScrubActive) return

    // Alt + right-drag → resize the brush, anchored where the drag began so the
    // ring grows concentrically instead of chasing the cursor.
    if (rightButton && alt) {
      editor.beginSizeScrub(p.x, p.y, 'pointer')
      return
    }

    // Ctrl + space + left-drag → zoom. Checked before the plain pan case, which
    // space + left-drag still owns.
    if (e.button === 0 && mods.space && ctrl) {
      nav.beginZoom(editor, p, e.clientY)
      return
    }

    if (e.button === 1 || rightButton || mods.space) {
      nav.beginPan(e.clientX, e.clientY, e.shiftKey)
      return
    }

    // Pointer Events reports the inverted (eraser) end as button 5 / buttons
    // bit 5. Honouring it must NOT change the selected tool — flip the pen back
    // and you should be painting again.
    const eraserEnd = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)

    if (!eraserEnd && (editor.tool === 'picker' || alt)) {
      editor.pickColor(doc)
      if (editor.tool === 'picker') editor.setTool('brush')
      return
    }

    strokePointerId = e.pointerId
    editor.beginStroke(toStrokePoint(e), eraserEnd || editor.tool === 'eraser')
    updateTelemetry(e)
  }

  const onMove = (e: PointerEvent, raw: boolean): void => {
    // Same recency gate as pointerdown — see Editor.wintabRecent.
    if (editor.wintabRecent) return
    const now = performance.now()
    if (raw) lastRawUpdate = now
    else if (now - lastRawUpdate < 150) {
      trackCursor(e)
      return
    }
    trackCursor(e)

    if (gesture && e.pointerType === 'touch') {
      const t = touches.get(e.pointerId)
      if (t) {
        t.x = e.clientX
        t.y = e.clientY
        updateGesture()
      }
      return
    }

    // Works for both bindings, and for a hovering pen as well as one in
    // contact — no button is required.
    if (editor.sizeScrubActive) {
      editor.updateSizeScrub(local(e).x)
      return
    }

    if (nav.move(editor, e.clientX, e.clientY)) return

    if (!editor.strokeActive || e.pointerId !== strokePointerId) {
      updateTelemetry(e)
      return
    }

    // The whole point of coalescing: between two frames the pen may have
    // reported five or ten times. Dropping those samples is what makes fast
    // strokes look like polygons.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : []
    const samples = coalesced.length > 0 ? coalesced : [e]
    for (const s of samples) editor.extendStroke(toStrokePoint(s))
    updateTelemetry(e)
  }

  const trackCursor = (e: PointerEvent): void => {
    const p = local(e)
    editor.cursor.x = p.x
    editor.cursor.y = p.y
    editor.cursor.visible = true
    editor.invalidate()
  }

  const onPointerUp = (e: PointerEvent): void => {
    touches.delete(e.pointerId)
    if (touches.size < 2) gesture = null
    nav.end()
    editor.endSizeScrub('pointer')
    if (editor.strokeActive && e.pointerId === strokePointerId) {
      editor.endStroke()
      strokePointerId = -1
    }
  }

  const onLeave = (): void => {
    editor.cursor.visible = false
    editor.invalidate()
  }

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    refreshRect()
    const p = local(e)
    if (e.altKey) {
      editor.camera.rotation += (e.deltaY > 0 ? 1 : -1) * 0.06
    } else if (e.ctrlKey) {
      editor.setBrush({ size: clamp(editor.brush.size * (e.deltaY > 0 ? 0.9 : 1.111), 1, 400) })
    } else {
      editor.camera.zoomAt(e.deltaY > 0 ? 0.88 : 1 / 0.88, p)
    }
    editor.invalidate()
  }

  function pair(): [Pt, Pt] | null {
    const a = [...touches.values()]
    return a.length >= 2 ? [a[0], a[1]] : null
  }

  function startGesture(): void {
    const p = pair()
    if (!p) return
    const [a, b] = p
    const mid = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 })
    gesture = {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      scale: editor.camera.scale,
      rotation: editor.camera.rotation,
      doc: editor.camera.screenToDoc(mid.x, mid.y)
    }
  }

  function updateGesture(): void {
    const p = pair()
    if (!p || !gesture) return
    const [a, b] = p
    const mid = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 })
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    editor.camera.scale = clamp((gesture.scale * dist) / gesture.dist, 0.02, 64)
    editor.camera.rotation = gesture.rotation + (angle - gesture.angle)
    editor.camera.anchor(gesture.doc, mid)
    editor.invalidate()
  }

  const onRawUpdate = (e: Event): void => onMove(e as PointerEvent, true)
  const onPointerMove = (e: PointerEvent): void => onMove(e, false)
  const onContextMenu = (e: Event): void => e.preventDefault()

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerrawupdate', onRawUpdate)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('scroll', refreshRect, true)
  window.addEventListener('resize', refreshRect)

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerrawupdate', onRawUpdate)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointercancel', onPointerUp)
    canvas.removeEventListener('pointerleave', onLeave)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('scroll', refreshRect, true)
    window.removeEventListener('resize', refreshRect)
  }
}
