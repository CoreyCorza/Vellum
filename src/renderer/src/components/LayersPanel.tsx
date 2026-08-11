import { useEditorState } from '../useEditor'
import { Slider } from './Slider'
import { BLEND_MODES, type BlendMode } from '@engine/types'

/**
 * Displayed top-to-bottom, which is the reverse of `doc.layers` — index 0 is the
 * bottom of the stack, matching paint order. Every art app does this; getting it
 * backwards is a classic source of confusing reorder bugs, so the conversion
 * happens here and nowhere else.
 */
export function LayersPanel({ showTitle = true }: { showTitle?: boolean }): JSX.Element {
  const editor = useEditorState()
  const { doc } = editor
  const display = doc.layers.map((l, i) => ({ layer: l, index: i })).reverse()
  const active = doc.active

  return (
    <div className="sec">
      <div className={`sec-head${showTitle ? '' : ' no-title'}`}>
        {showTitle && <h2>Layers</h2>}
        <div className="sec-actions">
          <button className="mini" title="New layer" onClick={() => editor.addLayer()}>
            +
          </button>
          <button className="mini" title="Duplicate layer" onClick={() => editor.duplicateLayer()}>
            ⧉
          </button>
          <button
            className="mini"
            title="Delete layer"
            disabled={doc.layers.length <= 1}
            onClick={() => editor.removeLayer()}
          >
            −
          </button>
        </div>
      </div>

      <div className="layer-list">
        {display.map(({ layer, index }) => (
          <div
            key={layer.id}
            className={`layer${index === doc.activeIndex ? ' active' : ''}`}
            onClick={() => editor.selectLayer(index)}
          >
            <button
              className="layer-eye"
              title={layer.visible ? 'Hide' : 'Show'}
              onClick={(e) => {
                e.stopPropagation()
                editor.setLayerProps(index, { visible: !layer.visible })
              }}
            >
              {layer.visible ? '◉' : '○'}
            </button>
            <span className="layer-name" title={layer.name}>
              {layer.name}
            </span>
            <button
              className="layer-lock"
              title={layer.locked ? 'Unlock' : 'Lock'}
              onClick={(e) => {
                e.stopPropagation()
                editor.setLayerProps(index, { locked: !layer.locked })
              }}
            >
              {layer.locked ? '🔒' : ''}
            </button>
            <div className="layer-move">
              <button
                title="Move up"
                disabled={index === doc.layers.length - 1}
                onClick={(e) => {
                  e.stopPropagation()
                  editor.moveLayer(index, index + 1)
                }}
              >
                ▲
              </button>
              <button
                title="Move down"
                disabled={index === 0}
                onClick={(e) => {
                  e.stopPropagation()
                  editor.moveLayer(index, index - 1)
                }}
              >
                ▼
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="row">
        <label htmlFor="blend">Blend</label>
        <select
          id="blend"
          value={active.blend}
          onChange={(e) =>
            editor.setLayerProps(doc.activeIndex, { blend: e.target.value as BlendMode })
          }
        >
          {BLEND_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <Slider
        label="Layer opacity"
        value={active.opacity * 100}
        min={0}
        max={100}
        step={1}
        defaultValue={100}
        format={(v) => `${Math.round(v)}%`}
        onChange={(v) => editor.setLayerProps(doc.activeIndex, { opacity: v / 100 })}
      />
    </div>
  )
}
