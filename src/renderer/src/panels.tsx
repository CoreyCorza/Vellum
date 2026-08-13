import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { loadPrefs, savePrefs } from './prefs'

/**
 * Every floating panel, in the order they appear in the Panels menu.
 *
 * One list rather than a menu that happens to match the components: adding a panel
 * should mean adding a line here, not remembering to update a second place. The ids
 * are the same ones FloatingPanel stores position and size under, so they are
 * already stable and already meaningful.
 */
export const PANELS = [
  { id: 'brush-panel', label: 'Brush Settings' },
  { id: 'brushes-panel', label: 'Brushes' },
  { id: 'color-panel', label: 'Colour' },
  { id: 'layers-panel', label: 'Layers' },
  { id: 'quick-rail', label: 'Quick rail' }
] as const

export type PanelId = (typeof PANELS)[number]['id']

/** Off unless asked for: it duplicates controls that already have a home. */
const DEFAULT_HIDDEN: PanelId[] = ['quick-rail']

interface PanelVisibility {
  isOpen: (id: string) => boolean
  toggle: (id: PanelId) => void
}

const Ctx = createContext<PanelVisibility | null>(null)

export function PanelVisibilityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [hidden, setHidden] = useState<string[]>(() => {
    const stored = loadPrefs().hiddenPanels
    return stored ?? [...DEFAULT_HIDDEN]
  })

  const toggle = useCallback((id: PanelId) => {
    setHidden((was) => {
      const next = was.includes(id) ? was.filter((x) => x !== id) : [...was, id]
      savePrefs({ hiddenPanels: next })
      return next
    })
  }, [])

  const value = useMemo<PanelVisibility>(
    () => ({ isOpen: (id) => !hidden.includes(id), toggle }),
    [hidden, toggle]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Everything visible and toggling a no-op, for any tree without a provider. */
const ALWAYS_OPEN: PanelVisibility = { isOpen: () => true, toggle: () => undefined }

export function usePanels(): PanelVisibility {
  return useContext(Ctx) ?? ALWAYS_OPEN
}
