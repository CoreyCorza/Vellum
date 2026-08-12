import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorState } from '../useEditor'
import { PresetThumbnails } from '@engine/brush/thumbnail'
import { Slider } from './Slider'
import { loadPrefs, savePrefs } from '../prefs'
import type { BrushPreset } from '@engine/brush/presets'

export type PresetView = 'list' | 'icons'

/**
 * The brush shelf — its own panel, so it can be resized to taste.
 *
 * That is the reason it is not a section of the settings panel: how many brushes
 * you want in view, and how big, is personal. Drag the panel wide and you get a
 * dense grid; drag it narrow and tall and you get one per row. The well takes
 * whatever height the panel has, so resizing does the whole job and there is no
 * option to set.
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
  const [renaming, setRenaming] = useState<string | null>(null)
  const headRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent): void => {
      if (!headRef.current?.contains(e.target as Node)) setMenu(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

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
  const sizeOf = (p: BrushPreset): number => Math.round(p.settings.size ?? 34)

  const nameField = (p: BrushPreset): JSX.Element =>
    renaming === p.id ? (
      <input
        className="preset-rename"
        autoFocus
        defaultValue={p.name}
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
    <div className="preset-shelf">
      <div className="sec-head" ref={headRef}>
        <h2>{presets.length} brushes</h2>
        <button
          className="sec-menu"
          aria-expanded={menu}
          title="View and tile size"
          onClick={() => setMenu((m) => !m)}
        >
          ⋯
        </button>
        {menu && (
          <div className="preset-menu" role="group" aria-label="Shelf view options">
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
          </div>
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
                onClick={() => editor.applyPreset(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    editor.applyPreset(p.id)
                  }
                }}
              >
                <img className="preset-strip" src={strips.get(p)} alt="" draggable={false} />
                {nameField(p)}
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
                onClick={() => editor.applyPreset(p.id)}
              >
                <img src={tiles.get(p)} alt="" draggable={false} />
                <span className="preset-badge">{sizeOf(p)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="preset-actions">
        <button
          className="mini"
          title="New brush — a plain default you then set up"
          onClick={() => {
            editor.addPreset(false)
            persist()
          }}
        >
          +
        </button>
        <button
          className="mini"
          title="New brush from the current settings — captures what you are using right now, eraser included"
          onClick={() => {
            editor.addPreset(true)
            persist()
          }}
        >
          ⧉
        </button>
        <button
          className="mini"
          disabled={!active}
          title={
            active
              ? 'Overwrite the selected brush with the current settings'
              : 'Select a brush first'
          }
          onClick={() => {
            if (active) editor.updatePresetFromBrush(active)
            persist()
          }}
        >
          ⤓
        </button>
        <span className="preset-actions-gap" />
        <button
          className="mini danger"
          disabled={!active}
          title={active ? 'Delete the selected brush' : 'Select a brush first'}
          onClick={() => {
            if (active) editor.deletePreset(active)
            persist()
          }}
        >
          −
        </button>
      </div>
    </div>
  )
}
