import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorState } from '../useEditor'
import { PresetThumbnails } from '@engine/brush/thumbnail'
import { Slider } from './Slider'
import { loadPrefs, savePrefs } from '../prefs'
import type { BrushPreset } from '@engine/brush/presets'
import { Chevron, Popover } from './Popover'

export type PresetView = 'list' | 'icons'

/** Below this the footer cannot hold five buttons, so it collapses to a menu. */
const NARROW = 168
/** Dead band, so dragging across the threshold does not flap back and forth. */
const NARROW_HYSTERESIS = 20

/**
 * The brush shelf — its own panel, so it can be resized to taste.
 *
 * How many brushes you want in view, and how big, is personal: drag the panel wide
 * for a dense grid, or squeeze it down to a single column. The well takes whatever
 * height and width the panel has, so the resize handle is the only control needed.
 *
 * The stroke comes first in a list row because it is what you choose by — the name
 * is confirmation, not the thing you scan for.
 */
export function PresetBox(): JSX.Element {
  const editor = useEditorState()
  const stored = useMemo(() => loadPrefs(), [])
  const [view, setView] = useState<PresetView>(stored.presetView)
  const [tile, setTile] = useState(stored.presetTileSize)
  const [menu, setMenu] = useState(false)
  const [actions, setActions] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const headRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const headBtn = useRef<HTMLButtonElement>(null)
  const footBtn = useRef<HTMLButtonElement>(null)

  // Two shapes, two renderers: a wide strip for the list and a square for the
  // tiles. Cropping the strip into a square magnifies its middle band, which made
  // every tile look like the same fat blob.
  const strips = useMemo(() => new PresetThumbnails(72, 22), [])
  const tiles = useMemo(() => new PresetThumbnails(64, 64), [])

  // A preset's settings can change under it — created from the current brush, or
  // overwritten — so previews cannot be cached forever.
  const shelfStamp = editor.presets.map((p) => p.id + ':' + p.settings.size).join(',')
  useEffect(() => {
    strips.invalidate()
    tiles.invalidate()
  }, [shelfStamp, strips, tiles])

  // Collapse on MEASURED width rather than a media query: this is a floating panel
  // the user drags, so the window's size says nothing about how wide it is.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      setNarrow((was) => (was ? w < NARROW + NARROW_HYSTERESIS : w < NARROW))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const closeAll = (): void => {
    setMenu(false)
    setActions(false)
    setArmed(false)
  }

  useEffect(() => {
    if (!menu && !actions) return
    const away = (e: PointerEvent): void => {
      const t = e.target as Node
      // The menus live in the document body now, so containment in the panel is no
      // longer the test for "inside".
      if ((t as Element)?.closest?.('.popover')) return
      if (!headRef.current?.contains(t) && !footRef.current?.contains(t)) closeAll()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeAll()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [menu, actions])

  const chooseView = (v: PresetView): void => {
    setView(v)
    savePrefs({ presetView: v })
  }
  const chooseTile = (px: number): void => {
    setTile(px)
    savePrefs({ presetTileSize: px })
  }
  const persist = (): void => savePrefs({ presets: editor.presets })

  const presets = editor.presets
  const active = editor.activePresetId
  const modified = editor.presetModified
  const selected = presets.find((p) => p.id === active)
  const sizeOf = (p: BrushPreset): number => Math.round(p.settings.size ?? 34)

  /**
   * Clicking the brush you are already on does nothing.
   *
   * It used to reload it, which quietly discarded whatever had just been changed in
   * the settings panel. Reloading is the revert button and nothing else.
   */
  const choose = (id: string): void => {
    if (id === active) return
    editor.applyPreset(id)
  }

  const addPlain = (): void => {
    editor.addPreset(false)
    persist()
    closeAll()
  }
  const addFromCurrent = (): void => {
    editor.addPreset(true)
    persist()
    closeAll()
  }
  const saveInto = (): void => {
    if (active) editor.updatePresetFromBrush(active)
    persist()
    closeAll()
  }
  const revert = (): void => {
    editor.revertPreset()
    closeAll()
  }
  /**
   * Delete asks twice: the first click arms it, the second does it.
   *
   * There is no undo for a deleted brush, and the button sits near the panel's
   * resize corner — a mis-drag landing on it would otherwise silently destroy a
   * brush someone had set up.
   */
  const remove = (): void => {
    if (!active) return
    if (!armed) {
      setArmed(true)
      return
    }
    editor.deletePreset(active)
    persist()
    closeAll()
  }
  const restoreDefaults = (): void => {
    editor.restoreDefaultPresets()
    persist()
    closeAll()
  }

  const nameField = (p: BrushPreset): JSX.Element =>
    renaming === p.id ? (
      <input
        className="preset-rename"
        autoFocus
        defaultValue={p.name}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            editor.renamePreset(p.id, (e.target as HTMLInputElement).value)
            setRenaming(null)
            persist()
          }
          if (e.key === 'Escape') setRenaming(null)
        }}
        onBlur={(e) => {
          editor.renamePreset(p.id, e.target.value)
          setRenaming(null)
          persist()
        }}
      />
    ) : (
      <span className="preset-name" onDoubleClick={() => setRenaming(p.id)}>
        {p.name}
      </span>
    )

  return (
    <div className={'preset-shelf' + (narrow ? ' narrow' : '')} ref={rootRef}>
      <div className="sec-head" ref={headRef}>
        {!narrow && <h2>{presets.length} brushes</h2>}
        <button
          className="sec-menu"
          ref={headBtn}
          aria-expanded={menu}
          title="View, tile size, restore defaults"
          onClick={() => {
            setActions(false)
            setMenu((m) => !m)
          }}
        >
          <Chevron />
        </button>
        {menu && (
          <Popover
            anchor={headBtn}
            placement="below-right"
            onClose={closeAll}
            className="preset-menu"
            label="Shelf options"
          >
            <div className="preset-menu-row">
              <button
                className="btn"
                aria-pressed={view === 'list'}
                onClick={() => chooseView('list')}
              >
                List
              </button>
              <button
                className="btn"
                aria-pressed={view === 'icons'}
                onClick={() => chooseView('icons')}
              >
                Icons
              </button>
            </div>
            {view === 'icons' && (
              <Slider
                label="Tile size"
                value={tile}
                min={28}
                max={96}
                step={1}
                defaultValue={48}
                format={(v) => `${Math.round(v)} px`}
                onChange={chooseTile}
              />
            )}
            <button className="btn" onClick={restoreDefaults}>
              Restore default brushes
            </button>
          </Popover>
        )}
      </div>

      <div className={`preset-well ${view}`}>
        {view === 'list' ? (
          <div className="preset-rows">
            {presets.map((p) => (
              <div
                key={p.id}
                className="preset-row"
                role="button"
                tabIndex={0}
                aria-pressed={active === p.id}
                onClick={() => choose(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    choose(p.id)
                  }
                }}
              >
                <img className="preset-strip" src={strips.get(p)} alt="" draggable={false} />
                {nameField(p)}
                {/* Always present, only sometimes visible: rendering it
                    conditionally moved the size column sideways every time a
                    slider was touched. */}
                <span
                  className={'preset-dirty' + (active === p.id && modified ? '' : ' invisible')}
                  title="Changed since you picked it — save it or revert with the buttons below"
                >
                  ●
                </span>
                <span className="preset-size">{sizeOf(p)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="preset-tiles"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))` }}
          >
            {presets.map((p) => (
              <button
                key={p.id}
                className="preset-tile"
                aria-pressed={active === p.id}
                title={p.name + ' — ' + sizeOf(p) + ' px'}
                onClick={() => choose(p.id)}
              >
                <img src={tiles.get(p)} alt="" draggable={false} />
                {active === p.id && modified && (
                  <span className="preset-dirty tile" title="Changed since you picked it">
                    ●
                  </span>
                )}
                <span className="preset-badge">{sizeOf(p)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Nothing destructive at the right-hand end: that corner belongs to the
          resize handle, and a mis-drag onto Delete would be unrecoverable. */}
      <div className="preset-actions" ref={footRef}>
        {narrow ? (
          <>
            <button
              className="mini"
              ref={footBtn}
              aria-expanded={actions}
              title="Brush actions"
              onClick={() => {
                setMenu(false)
                setArmed(false)
                setActions((a) => !a)
              }}
            >
              <Chevron />
            </button>
            {actions && (
              <Popover
                anchor={footBtn}
                placement="above-left"
                onClose={closeAll}
                className="preset-menu"
                label="Brush actions"
              >
                <button className="btn" onClick={addPlain}>
                  New brush
                </button>
                <button className="btn" onClick={addFromCurrent}>
                  New from current
                </button>
                <button className="btn" disabled={!modified} onClick={saveInto}>
                  Save changes
                </button>
                <button className="btn" disabled={!modified} onClick={revert}>
                  Revert changes
                </button>
                <button
                  className={'btn danger' + (armed ? ' armed' : '')}
                  disabled={!active}
                  onClick={remove}
                >
                  {armed ? 'Really delete?' : 'Delete brush'}
                </button>
              </Popover>
            )}
          </>
        ) : (
          <>
            <button
              className="mini"
              title="New brush — a plain default you then set up"
              onClick={addPlain}
            >
              +
            </button>
            <button
              className="mini"
              title="New brush from the current settings — captures what you are using right now, eraser included"
              onClick={addFromCurrent}
            >
              ⧉
            </button>
            <button
              className="mini"
              disabled={!active || !modified}
              title={
                !active
                  ? 'Select a brush first'
                  : modified
                    ? 'Save these changes into the selected brush'
                    : 'No changes to save'
              }
              onClick={saveInto}
            >
              ⤓
            </button>
            <button
              className="mini"
              disabled={!modified}
              title={
                modified ? 'Discard the changes and reload the brush' : 'No changes to discard'
              }
              onClick={revert}
            >
              ↺
            </button>
            <button
              className={'mini danger' + (armed ? ' armed' : '')}
              disabled={!active}
              title={
                !active
                  ? 'Select a brush first'
                  : armed
                    ? `Click again to delete ${selected?.name ?? 'this brush'}`
                    : `Delete ${selected?.name ?? 'the selected brush'}`
              }
              onBlur={() => setArmed(false)}
              onClick={remove}
            >
              {armed ? '✓' : '−'}
            </button>
            <span className="preset-actions-gap" />
          </>
        )}
      </div>
    </div>
  )
}
