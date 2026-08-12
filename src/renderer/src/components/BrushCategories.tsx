import { useState, type ReactNode } from 'react'
import { loadPrefs, savePrefs } from '../prefs'

export interface BrushCategory {
  id: string
  label: string
  /** Sketched, not wired up. Dimmed in the list and tagged in the pane. */
  planned?: boolean
  /** Shown as a dot beside the name: this category is doing something. */
  active?: boolean
  body: ReactNode
}

/**
 * A fixed list of categories beside a pane showing one of them.
 *
 * This replaced collapsible sections, which were the obvious way to fit a long
 * settings list into a narrow panel and were wrong for this one: expanding and
 * collapsing moves everything below, so the controls you are reaching for are never
 * where they were a moment ago, and a closed panel leaves a hole under the last
 * section. The same objection applies to any layout that changes size as you use it.
 *
 * A list and a pane never move. The list is the same height whatever is selected,
 * and the pane's content swaps inside a region whose size the user set by dragging
 * the panel. Photoshop and Clip Studio both do exactly this, and it only became
 * possible here once the panel was allowed to be wide.
 *
 * The pane will sometimes have space at the bottom. That is a fixed area, not a
 * shifting one, which is the whole difference.
 */
export function BrushCategories({ categories }: { categories: BrushCategory[] }): JSX.Element {
  const [selected, setSelected] = useState(() => {
    const stored = loadPrefs().brushCategory
    return stored && categories.some((c) => c.id === stored) ? stored : categories[0].id
  })

  const choose = (id: string): void => {
    setSelected(id)
    savePrefs({ brushCategory: id })
  }

  const current = categories.find((c) => c.id === selected) ?? categories[0]

  return (
    <div className="cat">
      <div className="cat-list" role="tablist" aria-label="Brush setting categories">
        {categories.map((c) => (
          <button
            key={c.id}
            className={'cat-item' + (c.planned ? ' planned' : '')}
            role="tab"
            aria-selected={c.id === current.id}
            onClick={() => choose(c.id)}
          >
            <span className="cat-name">{c.label}</span>
            {/* Which categories are doing something, so the list answers "what is
                this brush made of" without visiting each one. Photoshop uses a
                checkbox for the same job. */}
            {c.active && <span className="cat-dot" aria-label="in use" />}
          </button>
        ))}
      </div>

      <div className="cat-pane" role="tabpanel" aria-label={current.label}>
        <div className="cat-pane-head">
          <span>{current.label}</span>
          {current.planned && <span className="sect-planned">planned</span>}
        </div>
        <div className={'cat-pane-body' + (current.planned ? ' planned' : '')}>{current.body}</div>
      </div>
    </div>
  )
}
