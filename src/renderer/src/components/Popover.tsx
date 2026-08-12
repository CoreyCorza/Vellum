import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type PopoverPlacement = 'below-right' | 'above-left'

/**
 * A menu that escapes its panel.
 *
 * Floating panels clip their contents — overflow: hidden, so the rounded corners
 * actually round — which meant a menu opening near the bottom or the right edge was
 * simply cut off, and the items you could not see were the ones you wanted. This
 * renders into the document body and is positioned from the trigger's screen rect,
 * so it can hang outside the panel.
 *
 * Placed with `right`/`bottom` rather than `left`/`top` where it is aligned to that
 * side, so no measurement of the menu itself is needed and there is no frame where
 * it sits in the wrong place before being corrected.
 */
export function Popover({
  anchor,
  placement,
  onClose,
  className = '',
  label,
  children
}: {
  anchor: RefObject<HTMLElement>
  placement: PopoverPlacement
  onClose: () => void
  className?: string
  label: string
  children: ReactNode
}): JSX.Element | null {
  const [style, setStyle] = useState<Record<string, number | string> | null>(null)

  useEffect(() => {
    const place = (): void => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const gap = 4
      setStyle(
        placement === 'below-right'
          ? { top: Math.round(r.bottom + gap), right: Math.round(window.innerWidth - r.right) }
          : { bottom: Math.round(window.innerHeight - r.top + gap), left: Math.round(r.left) }
      )
    }
    place()

    // Anything that moves the trigger invalidates the position. Reposition on a
    // window resize and close on scroll, since a scrolled-away anchor usually means
    // the menu is no longer where the user is looking.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [anchor, placement, onClose])

  if (!style) return null
  return createPortal(
    <div className={`popover ${className}`} role="group" aria-label={label} style={style}>
      {children}
    </div>,
    document.body
  )
}

/** The affordance that says "this opens a menu". */
export function Chevron(): JSX.Element {
  return (
    <svg className="chev" width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
      <path
        d="M1 1.25 4.5 4.75 8 1.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Says "options for this panel", as distinct from a chevron's "opens downwards". */
export function Hamburger(): JSX.Element {
  return (
    <svg className="chev" width="11" height="9" viewBox="0 0 11 9" aria-hidden="true">
      <path
        d="M1 1.5h9M1 4.5h9M1 7.5h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
