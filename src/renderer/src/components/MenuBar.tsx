import { useEffect, useRef } from 'react'
import { useEditorState } from '../useEditor'
import { PANELS, usePanels } from '../panels'

export interface MenuEntry {
  label?: string
  /** Shown with a tick. For entries that describe a state rather than an action. */
  checked?: boolean
  shortcut?: string
  onSelect?: () => void
  disabled?: boolean
  separator?: boolean
  /** Shown as a tooltip — used to mark placeholders honestly. */
  note?: string
}

interface MenuDef {
  title: string
  items: MenuEntry[]
}

/**
 * Application menu bar.
 *
 * Rendered in the renderer rather than as a native Electron menu, deliberately:
 * a native menu with accelerators would double-fire against the keyboard
 * handler in App.tsx (press Ctrl+Z once, undo twice), and `dev:web` would lose
 * the menu entirely. Everything stays on one code path this way.
 *
 * Open state is owned by App so the keyboard shortcuts can stand down while a
 * menu is showing.
 */
export function MenuBar({
  open,
  onOpenChange,
  onExport,
  onOpenSettings
}: {
  open: string | null
  onOpenChange: (next: string | null) => void
  onExport: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const editor = useEditorState()
  const panels = usePanels()
  const barRef = useRef<HTMLDivElement>(null)

  // Click anywhere outside, or Escape, closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) onOpenChange(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(null)
    }
    // capture, so it runs before the canvas gets a chance to start a stroke
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  const todo = (label: string): MenuEntry => ({
    label,
    disabled: true,
    note: 'Not implemented yet'
  })

  const menus: MenuDef[] = [
    {
      title: 'File',
      items: [
        todo('New…'),
        todo('Open…'),
        { separator: true },
        todo('Save'),
        todo('Save As…'),
        { label: 'Export PNG…', shortcut: 'Ctrl+S', onSelect: onExport },
        { separator: true },
        { label: 'Settings…', onSelect: onOpenSettings },
        { separator: true },
        {
          label: 'Exit',
          onSelect: () => window.close(),
          note: 'Closes the window'
        }
      ]
    },
    {
      title: 'Edit',
      items: [
        {
          label: 'Undo',
          shortcut: 'Ctrl+Z',
          disabled: !editor.history.canUndo,
          onSelect: () => editor.undo()
        },
        {
          label: 'Redo',
          shortcut: 'Ctrl+Shift+Z',
          disabled: !editor.history.canRedo,
          onSelect: () => editor.redo()
        },
        { separator: true },
        { label: 'Select all', shortcut: 'Ctrl+A', onSelect: () => editor.selectAll() },
        {
          label: 'Deselect',
          shortcut: 'Ctrl+D',
          disabled: !editor.selectionActive,
          onSelect: () => editor.deselect()
        },
        { separator: true },
        { label: 'Clear layer', onSelect: () => editor.clearLayer() },
        { separator: true },
        todo('Cut'),
        todo('Copy'),
        todo('Paste')
      ]
    },
    {
      title: 'View',
      items: [
        {
          label: 'Fit to screen',
          shortcut: 'F',
          onSelect: () => {
            editor.camera.fit(editor.doc.width, editor.doc.height)
            editor.invalidate()
          }
        },
        {
          label: 'Actual size',
          shortcut: '1',
          onSelect: () => {
            editor.camera.scale = 1
            editor.camera.rotation = 0
            editor.invalidate()
          }
        },
        {
          label: 'Reset rotation',
          onSelect: () => {
            editor.camera.rotation = 0
            editor.invalidate()
          }
        },
        { separator: true },
        todo('Show grid'),
        todo('Full screen')
      ]
    },
    {
      title: 'Panels',
      items: PANELS.map((p) => ({
        label: p.label,
        checked: panels.isOpen(p.id),
        onSelect: () => panels.toggle(p.id)
      }))
    }
  ]

  return (
    <div id="menubar" ref={barRef}>
      <span className="menubar-brand">Vellum</span>
      {menus.map((menu) => {
        const checkable = menu.items.some((i) => i.checked !== undefined)
        return (
        <div className="menu-root" key={menu.title}>
          <button
            className="menu-title"
            aria-expanded={open === menu.title}
            onClick={() => onOpenChange(open === menu.title ? null : menu.title)}
            // Once one menu is open, sliding across the bar switches between
            // them without another click — standard menu-bar behaviour.
            onPointerEnter={() => {
              if (open && open !== menu.title) onOpenChange(menu.title)
            }}
          >
            {menu.title}
          </button>

          {open === menu.title && (
            <div className="menu-pop" role="menu">
              {menu.items.map((item, i) =>
                item.separator ? (
                  <div className="menu-sep" key={`sep${i}`} />
                ) : (
                  <button
                    key={item.label}
                    className="menu-item"
                    role="menuitem"
                    disabled={item.disabled}
                    title={item.note}
                    onClick={() => {
                      onOpenChange(null)
                      item.onSelect?.()
                    }}
                  >
                    {/* The tick column is reserved only in menus that have
                        something to tick. Rendering it everywhere added a third
                        flex child to every item, and space-between then pushed the
                        labels into the middle of File, Edit and View. */}
                    {checkable && (
                      <span className="menu-tick" aria-hidden="true">
                        {item.checked === true ? '✓' : ''}
                      </span>
                    )}
                    <span className="menu-label">{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}
