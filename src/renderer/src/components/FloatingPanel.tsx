import { useEffect, useRef, useState, type ReactNode } from 'react'

type Point = { x: number; y: number }

let highestPanelZ = 20

const constrainPosition = (panel: HTMLDivElement, position: Point): Point => {
  const root = panel.parentElement
  if (!root) return position

  const margin = 4
  const statusHeight = root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0
  const maxX = Math.max(margin, root.clientWidth - panel.offsetWidth - margin)
  const maxY = Math.max(
    margin,
    root.clientHeight - statusHeight - panel.offsetHeight - margin
  )

  return {
    x: Math.max(margin, Math.min(maxX, position.x)),
    y: Math.max(margin, Math.min(maxY, position.y))
  }
}

export function FloatingPanel({
  id,
  title,
  initialTop,
  initialRight,
  children
}: {
  id: string
  title: string
  initialTop: number
  initialRight: number
  children: ReactNode
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const [position, setPosition] = useState<Point | null>(null)
  const [zIndex, setZIndex] = useState(highestPanelZ)

  useEffect(() => {
    const panel = panelRef.current
    const root = panel?.parentElement
    if (!panel || !root) return

    const keepOnscreen = (): void => {
      setPosition((current) => {
        const rootRect = root.getBoundingClientRect()
        const panelRect = panel.getBoundingClientRect()
        return constrainPosition(
          panel,
          current ?? { x: panelRect.left - rootRect.left, y: panelRect.top - rootRect.top }
        )
      })
    }
    const observer = new ResizeObserver(keepOnscreen)
    observer.observe(root)
    keepOnscreen()

    return () => observer.disconnect()
  }, [])

  const movePanel = (clientX: number, clientY: number): void => {
    const panel = panelRef.current
    const root = panel?.parentElement
    if (!panel || !root || !drag.current) return

    const rootRect = root.getBoundingClientRect()
    setPosition(
      constrainPosition(panel, {
        x: clientX - rootRect.left - drag.current.offsetX,
        y: clientY - rootRect.top - drag.current.offsetY
      })
    )
  }

  return (
    <div
      ref={panelRef}
      id={id}
      className="floating-panel"
      style={
        position
          ? { left: position.x, top: position.y, zIndex }
          : { right: initialRight, top: initialTop, zIndex }
      }
    >
      <div
        className="floating-panel-head"
        onPointerDown={(event) => {
          if (event.button !== 0 || !panelRef.current) return
          const bounds = panelRef.current.getBoundingClientRect()
          drag.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - bounds.left,
            offsetY: event.clientY - bounds.top
          }
          highestPanelZ += 1
          setZIndex(highestPanelZ)
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            movePanel(event.clientX, event.clientY)
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
        <span>{title}</span>
        <i aria-hidden="true" />
      </div>
      <div className="floating-panel-body">{children}</div>
    </div>
  )
}
