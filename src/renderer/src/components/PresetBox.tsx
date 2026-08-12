import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorState } from '../useEditor'
import { PresetThumbnails } from '@engine/brush/thumbnail'
import { Slider } from './Slider'
import { loadPrefs, savePrefs } from '../prefs'

export type PresetView = 'list' | 'icons'

/**
 * The preset shelf.
 *
 * Two views of one set of presets rather than two features: the list shows the
 * stroke, its name and its size, and the icon grid shows the same previews packed
 * tighter. The stroke comes FIRST in a list row because it is what you choose by
 * — the name is confirmation, not the thing you scan for.
 *
 * View and tile size live in a popover off the section header, so neither costs a
 * permanent row of panel height for a setting you change rarely.
 */
export function PresetBox(): JSX.Element {
  const editor = useEditorState()
  const stored = useMemo(() => loadPrefs(), [])
  const [view, setView] = useState<PresetView>(stored.presetView)
  const [tile, setTile] = useState(stored.presetTileSize)
  const [menu, setMenu] = useState(false)
  const headRef = useRef<HTMLDivElement>(null)

  // Two shapes, two renderers: a wide strip for the list and a square for the
  // tiles. Cropping the strip into a square magnifies its middle band, which made
  // every tile look like the same fat blob.
  const strips = useMemo(() => new PresetThumbnails(72, 22), [])
  const tiles = useMemo(() => new PresetThumbnails(64, 64), [])

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

  const presets = editor.presets
  const active = editor.activePresetId

  return (
    <div className="sec">
      <div className="sec-head" ref={headRef}>
        <h2>Presets</h2>
        <button
          className="sec-menu"
          aria-expanded={menu}
          title="View and size"
          onClick={() => setMenu((m) => !m)}
        >
          ⋯
        </button>
        {menu && (
          <div className="preset-menu" role="group" aria-label="Preset view options">
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
              <button
                key={p.id}
                className="preset-row"
                aria-pressed={active === p.id}
                onClick={() => editor.applyPreset(p.id)}
              >
                <img className="preset-strip" src={strips.get(p)} alt="" draggable={false} />
                <span className="preset-name">{p.name}</span>
                <span className="preset-size">
                  {Math.round((p.settings.size ?? 34) as number)}
                </span>
              </button>
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
                title={`${p.name} — ${Math.round((p.settings.size ?? 34) as number)} px`}
                onClick={() => editor.applyPreset(p.id)}
              >
                <img src={tiles.get(p)} alt="" draggable={false} />
                <span className="preset-badge">
                  {Math.round((p.settings.size ?? 34) as number)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
