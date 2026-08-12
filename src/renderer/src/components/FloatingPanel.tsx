import { usePanels } from '../panels'
import { Hamburger, Popover } from './Popover'
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

const constrainSize = (
  panel: HTMLDivElement,
  size: FloatingSize,
  minWidthWanted = 180
): FloatingSize => {
  const root = panel.parentElement
  if (!root) return size

  const statusHeight = root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0
  const maxWidth = Math.max(1, root.clientWidth - 8)
  const maxHeight = Math.max(1, root.clientHeight - statusHeight - 8)
  // 180 suits a panel of labelled sliders, which stop being readable much below
  // it. A grid of thumbnails does not care, and being able to squeeze it to one
  // tile per row is the point of letting it resize at all — so the floor is a prop.
  const minWidth = Math.min(minWidthWanted, maxWidth)
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
  hideTitle,
  variant = 'panel',
  menu,
  minWidth,
  initialWidth,
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
  /** Drop the title text but keep the bar, for a panel narrow enough that a name
   *  would be the widest thing in it. */
  hideTitle?: boolean
  /**
   * 'rail' borrows the tool rail's chrome: a small centred grip instead of a
   * titled bar. A strip of two sliders is more of a rail than a panel, and the two
   * sitting side by side with different headers looked like an oversight.
   */
  variant?: 'panel' | 'rail'
  /**
   * View options for THIS panel — the contents of the header's hamburger.
   *
   * Lives here rather than inside each panel's body so it costs no body height and
   * sits in the same place on every panel: a header is where you look for "how do I
   * want to see this", and the body is for the thing itself.
   */
  menu?: ReactNode
  /** Narrowest the user may drag this panel. Defaults to 180. */
  minWidth?: number
  /** Starting width. Defaults to 220, which suits a panel of labelled rows and is
   *  far too wide for something like the quick rail. */
  initialWidth?: number
  initialTop: number
  initialRight: number
  initialHeight?: number
  children: ReactNode
}): JSX.Element | null {
  // Asked here rather than at each call site: a panel that has been closed should
  // not render, and its CHILDREN should not mount either — the Brushes shelf holds
  // a WebGL context for its previews, so a hidden panel quietly costing one would
  // be a poor trade for a shorter component.
  const panels = usePanels()
  const panelRef = useRef<HTMLDivElement>(null)
  const menuBtn = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
    loadFloatingSize(id) ??
      (initialHeight ? { width: initialWidth ?? 220, height: initialHeight } : null)
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
        setSize(constrainSize(panel, preferredSize.current, minWidth))
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
    }, minWidth)
    preferredSize.current = next
    setSize(next)
  }

  if (!panels.isOpen(id)) return null

  return (
    <div
      ref={panelRef}
      id={id}
      className="floating-panel"
      style={
        position
          ? {
              left: position.x,
              top: position.y,
              width: size?.width,
              height: size?.height,
              minWidth,
              zIndex
            }
          : {
              right: initialRight,
              top: initialTop,
              width: size?.width,
              height: size?.height,
              minWidth,
              zIndex
            }
      }
    >
      <div
        className={`floating-panel-head${variant === 'rail' ? ' rail-head' : ''}`}
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
        {variant === 'rail' ? (
          <i aria-hidden="true" />
        ) : (
          <span>
            {hideTitle ? '' : title}
            {titleSuffix}
          </span>
        )}
        {menu && (
          <button
            className="panel-menu"
            ref={menuBtn}
            aria-expanded={menuOpen}
            aria-label={`${title} view options`}
            title="View options"
            // The header drags the panel, so the button has to keep its press.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Hamburger />
          </button>
        )}
      </div>
      <div className="floating-panel-body">{children}</div>

      {menu && menuOpen && (
        <Popover
          anchor={menuBtn}
          placement="below-right"
          onClose={() => setMenuOpen(false)}
          className="preset-menu"
          label={`${title} view options`}
        >
          <div onClick={() => setMenuOpen(false)}>{menu}</div>
        </Popover>
      )}
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
