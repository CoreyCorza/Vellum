import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  anchorForFloatingPosition,
  constrainFloatingPosition,
  loadFloatingAnchor,
  loadFloatingSize,
  positionForFloatingAnchor,
  saveFloatingAnchor,
  saveFloatingSize,
  type FloatingAnchor,
  type FloatingPoint,
  type FloatingSize
} from './floatingPosition'

let highestPanelZ = 20

const constrainSize = (panel: HTMLDivElement, size: FloatingSize): FloatingSize => {
  const root = panel.parentElement
  if (!root) return size

  const statusHeight = root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0
  const maxWidth = Math.max(1, root.clientWidth - 8)
  const maxHeight = Math.max(1, root.clientHeight - statusHeight - 8)
  const minWidth = Math.min(180, maxWidth)
  const minHeight = Math.min(120, maxHeight)

  return {
    width: Math.max(minWidth, Math.min(maxWidth, size.width)),
    height: Math.max(minHeight, Math.min(maxHeight, size.height))
  }
}

export function FloatingPanel({
  id,
  title,
  titleSuffix,
  initialTop,
  initialRight,
  initialHeight,
  children
}: {
  id: string
  title: string
  /** Shown after the title, dimmer. For "which thing am I editing" — kept
   *  separate so the accessible name and the resize label stay stable. */
  titleSuffix?: ReactNode
  initialTop: number
  initialRight: number
  initialHeight?: number
  children: ReactNode
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const resize = useRef<{
    pointerId: number
    startX: number
    startY: number
    startWidth: number
    startHeight: number
  } | null>(null)
  const anchor = useRef<FloatingAnchor>(
    loadFloatingAnchor(id, {
      horizontal: 'right',
      vertical: 'top',
      offsetX: initialRight,
      offsetY: initialTop
    })
  )
  const preferredSize = useRef<FloatingSize | null>(
    loadFloatingSize(id) ?? (initialHeight ? { width: 220, height: initialHeight } : null)
  )
  const [position, setPosition] = useState<FloatingPoint | null>(null)
  const [size, setSize] = useState<FloatingSize | null>(preferredSize.current)
  const [zIndex, setZIndex] = useState(highestPanelZ)

  useEffect(() => {
    const panel = panelRef.current
    const root = panel?.parentElement
    if (!panel || !root) return

    const keepOnscreen = (): void => {
      if (resize.current) {
        anchor.current = anchorForFloatingPosition(panel, {
          x: panel.offsetLeft,
          y: panel.offsetTop
        })
        return
      }
      if (preferredSize.current) {
        setSize(constrainSize(panel, preferredSize.current))
      }
      setPosition(positionForFloatingAnchor(panel, anchor.current))
    }
    const observer = new ResizeObserver(keepOnscreen)
    observer.observe(root)
    observer.observe(panel)
    keepOnscreen()

    return () => observer.disconnect()
  }, [])

  const movePanel = (clientX: number, clientY: number): void => {
    const panel = panelRef.current
    const root = panel?.parentElement
    if (!panel || !root || !drag.current) return

    const rootRect = root.getBoundingClientRect()
    const next = constrainFloatingPosition(panel, {
      x: clientX - rootRect.left - drag.current.offsetX,
      y: clientY - rootRect.top - drag.current.offsetY
    })
    anchor.current = anchorForFloatingPosition(panel, next)
    setPosition(next)
  }

  const resizePanel = (clientX: number, clientY: number): void => {
    const panel = panelRef.current
    if (!panel || !resize.current) return

    const next = constrainSize(panel, {
      width: resize.current.startWidth + clientX - resize.current.startX,
      height: resize.current.startHeight + clientY - resize.current.startY
    })
    preferredSize.current = next
    setSize(next)
  }

  return (
    <div
      ref={panelRef}
      id={id}
      className="floating-panel"
      style={
        position
          ? { left: position.x, top: position.y, width: size?.width, height: size?.height, zIndex }
          : { right: initialRight, top: initialTop, width: size?.width, height: size?.height, zIndex }
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
          saveFloatingAnchor(id, anchor.current)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => {
          if (drag.current) saveFloatingAnchor(id, anchor.current)
          drag.current = null
        }}
      >
        <span>
          {title}
          {titleSuffix}
        </span>
        <i aria-hidden="true" />
      </div>
      <div className="floating-panel-body">{children}</div>
      <div
        className="floating-panel-resize"
        title="Resize panel"
        aria-label={`Resize ${title} panel`}
        onPointerDown={(event) => {
          if (event.button !== 0 || !panelRef.current) return
          resize.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startWidth: panelRef.current.offsetWidth,
            startHeight: panelRef.current.offsetHeight
          }
          highestPanelZ += 1
          setZIndex(highestPanelZ)
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerMove={(event) => {
          if (resize.current?.pointerId === event.pointerId) {
            resizePanel(event.clientX, event.clientY)
          }
        }}
        onPointerUp={(event) => {
          if (resize.current?.pointerId !== event.pointerId) return
          resize.current = null
          if (panelRef.current) {
            anchor.current = anchorForFloatingPosition(panelRef.current, {
              x: panelRef.current.offsetLeft,
              y: panelRef.current.offsetTop
            })
          }
          if (preferredSize.current) saveFloatingSize(id, preferredSize.current)
          saveFloatingAnchor(id, anchor.current)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => {
          if (resize.current && preferredSize.current) {
            saveFloatingSize(id, preferredSize.current)
            saveFloatingAnchor(id, anchor.current)
          }
          resize.current = null
        }}
      />
    </div>
  )
}
