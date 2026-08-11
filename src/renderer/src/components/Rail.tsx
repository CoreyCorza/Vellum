import { useEffect, useRef, useState } from 'react'
import { useEditorState } from '../useEditor'
import type { ToolId } from '@engine/types'

const icons: Record<string, JSX.Element> = {
  brush: (
    <>
      <path d="M4 20c3 1 5-1 5-3.5S7.5 13 6 14.5 4 20 4 20Z" />
      <path d="M10.5 15.5 20 6a1.8 1.8 0 0 0-2.5-2.5L8 13" />
    </>
  ),
  eraser: (
    <>
      <path d="M8 20h12" />
      <path d="m4.5 16.5 6-6a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L15 20H8l-3.5-3.5Z" />
    </>
  ),
  picker: (
    <>
      <path d="m13 7 4 4" />
      <path d="M15 5.5 18.5 9 9 18.5l-4 1 1-4L15 5.5Z" />
    </>
  ),
  undo: (
    <>
      <path d="M4 9h10a5 5 0 0 1 0 10H9" />
      <path d="m8 5-4 4 4 4" />
    </>
  ),
  redo: (
    <>
      <path d="M20 9H10a5 5 0 0 0 0 10h5" />
      <path d="m16 5 4 4-4 4" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </>
  ),
  save: (
    <>
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 18h14" />
    </>
  )
}

const Icon = ({ name }: { name: string }): JSX.Element => (
  <svg viewBox="0 0 24 24">{icons[name]}</svg>
)

const constrainPosition = (
  rail: HTMLDivElement,
  position: { x: number; y: number }
): { x: number; y: number } => {
  const root = rail.parentElement
  if (!root) return position

  const margin = 4
  const statusHeight = root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0
  const maxX = Math.max(margin, root.clientWidth - rail.offsetWidth - margin)
  const maxY = Math.max(
    margin,
    root.clientHeight - statusHeight - rail.offsetHeight - margin
  )

  return {
    x: Math.max(margin, Math.min(maxX, position.x)),
    y: Math.max(margin, Math.min(maxY, position.y))
  }
}

export function Rail({ onExport }: { onExport: () => void }): JSX.Element {
  const editor = useEditorState()
  const railRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const [position, setPosition] = useState({ x: 10, y: 10 })

  const moveRail = (clientX: number, clientY: number): void => {
    const rail = railRef.current
    const root = rail?.parentElement
    if (!rail || !root || !drag.current) return

    const rootRect = root.getBoundingClientRect()
    setPosition(
      constrainPosition(rail, {
        x: clientX - rootRect.left - drag.current.offsetX,
        y: clientY - rootRect.top - drag.current.offsetY
      })
    )
  }

  useEffect(() => {
    const rail = railRef.current
    const root = rail?.parentElement
    if (!rail || !root) return

    const keepOnscreen = (): void => {
      setPosition((current) => constrainPosition(rail, current))
    }
    const observer = new ResizeObserver(keepOnscreen)
    observer.observe(root)
    keepOnscreen()

    return () => observer.disconnect()
  }, [])

  const tool = (id: ToolId, title: string): JSX.Element => (
    <button
      className="tool"
      title={title}
      aria-pressed={editor.tool === id}
      onClick={() => editor.setTool(id)}
    >
      <Icon name={id} />
    </button>
  )

  return (
    <div ref={railRef} id="rail" style={{ left: position.x, top: position.y }}>
      <div
        className="rail-grab"
        title="Drag toolbar"
        aria-label="Drag toolbar"
        onPointerDown={(event) => {
          if (event.button !== 0 || !railRef.current) return
          const bounds = railRef.current.getBoundingClientRect()
          drag.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - bounds.left,
            offsetY: event.clientY - bounds.top
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            moveRail(event.clientX, event.clientY)
          }
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => {
          drag.current = null
        }}
      >
        <i />
      </div>
      {tool('brush', 'Brush (B)')}
      {tool('eraser', 'Eraser (E)')}
      {tool('picker', 'Eyedropper (I, or hold Alt)')}
      <div className="rail-sep" />
      <button
        className="tool"
        title="Undo (Ctrl+Z)"
        disabled={!editor.history.canUndo}
        onClick={() => editor.undo()}
      >
        <Icon name="undo" />
      </button>
      <button
        className="tool"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!editor.history.canRedo}
        onClick={() => editor.redo()}
      >
        <Icon name="redo" />
      </button>
      <div className="rail-sep" />
      <button
        className="tool"
        title="Fit to screen (F)"
        onClick={() => {
          editor.camera.fit(editor.doc.width, editor.doc.height)
          editor.invalidate()
        }}
      >
        <Icon name="fit" />
      </button>
      <div className="rail-sep" />
      <button className="tool" title="Export PNG (Ctrl+S)" onClick={onExport}>
        <Icon name="save" />
      </button>
    </div>
  )
}
