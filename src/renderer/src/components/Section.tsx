import { useCallback, useState, type ReactNode } from 'react'
import { loadPrefs, savePrefs } from '../prefs'

/**
 * A collapsible group of settings.
 *
 * Photoshop, Krita and Clip Studio all solve a long settings list the same way — a
 * category list down one side, the chosen category's controls beside it — and all
 * three can afford it because they are wide dialogues. This is a 236px floating
 * panel: a sidebar would leave about 140px for the controls themselves.
 *
 * So the categories stack instead, and collapse. Two things that buys over a
 * sidebar, rather than merely coping without one:
 *
 *   · a collapsed section still reports its values in the header, so the panel
 *     answers "what is this brush doing" without any clicking at all, and
 *   · more than one can be open at once, which matters when the setting you are
 *     tuning interacts with another — a sidebar can only ever show you one.
 *
 * Open state is remembered, since which categories you care about is a working
 * habit rather than a per-session decision.
 */
export function Section({
  id,
  title,
  summary,
  defaultOpen = false,
  planned = false,
  children
}: {
  id: string
  title: string
  /** Shown in the header when collapsed: the values, not a description. */
  summary?: ReactNode
  defaultOpen?: boolean
  /**
   * Sketched, not wired up. The controls show so the shape of the feature can be
   * judged, but nothing responds and the header says so — a control that looks live
   * and does nothing is worse than an obviously unfinished one.
   */
  planned?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(() => {
    const stored = loadPrefs().openSections
    return stored ? stored.includes(id) : defaultOpen
  })

  const toggle = useCallback(() => {
    setOpen((was) => {
      const next = !was
      const stored = loadPrefs().openSections ?? []
      const set = new Set(stored)
      if (next) set.add(id)
      else set.delete(id)
      savePrefs({ openSections: [...set] })
      return next
    })
  }, [id])

  return (
    <div className={'sect' + (open ? ' open' : '')}>
      <button className="sect-head" aria-expanded={open} onClick={toggle}>
        <svg className="sect-arrow" width="7" height="9" viewBox="0 0 7 9" aria-hidden="true">
          <path d="M1.5 1 5.5 4.5 1.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <span className="sect-title">{title}</span>
        {/* Hidden when open, because the controls themselves are then the summary
            and the same numbers twice is noise. */}
        {!open && summary !== undefined && <span className="sect-summary">{summary}</span>}
        {planned && <span className="sect-planned">planned</span>}
      </button>
      {open && (
        <div className={'sect-body' + (planned ? ' planned' : '')} aria-disabled={planned}>
          {children}
        </div>
      )}
    </div>
  )
}
