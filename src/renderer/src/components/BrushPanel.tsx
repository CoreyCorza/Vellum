import { useState } from 'react'
import { useEditorState } from '../useEditor'
import { Slider } from './Slider'
import { ColorPicker } from './ColorPicker'
import { LayersPanel } from './LayersPanel'
import { FloatingPanel } from './FloatingPanel'
import { CurveEditor } from './CurveEditor'
import { PRESETS, type BrushSettings } from '@engine/brush/settings'

const pct = (v: number): string => `${Math.round(v)}%`

export function BrushPanel(): JSX.Element {
  const editor = useEditorState()
  const b = editor.brush
  const [preset, setPreset] = useState<string | null>(null)

  // In eraser mode every row states whether it is still following the brush.
  // In brush mode the props are omitted, so nothing extra renders and the panel
  // stays exactly as clean as it was.
  const erasing = editor.tool === 'eraser'
  const link = (
    key: keyof BrushSettings
  ): { follows?: boolean; onRelink?: () => void } =>
    erasing
      ? { follows: editor.eraserFollows(key), onRelink: () => editor.relinkEraser(key) }
      : {}

  const check = (
    id: string,
    label: string,
    key: 'pressureToSize' | 'pressureToOpacity' | 'pressureToFlow' | 'tiltToSize' | 'speedToSize'
  ): JSX.Element => (
    <label className="chk" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={b[key]}
        onChange={(e) => editor.setBrush({ [key]: e.target.checked })}
      />
      {label}
    </label>
  )

  return (
    <>
      <FloatingPanel id="brush-panel" title="Brush" initialTop={10} initialRight={10}>
      <div className="sec">
        <h2>Preset</h2>
        <div id="presets">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="preset"
              aria-pressed={preset === p.name}
              onClick={() => {
                setPreset(p.name)
                editor.setBrush(p.settings)
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="sec">
        <h2>{erasing ? 'Eraser' : 'Brush'}</h2>
        {erasing && (
          <div className="eraser-note">
            <p className="hint">
              {editor.eraserOverrideCount === 0
                ? 'Following the brush. Change anything to give the eraser its own.'
                : `${editor.eraserOverrideCount} setting${
                    editor.eraserOverrideCount === 1 ? '' : 's'
                  } of its own; the rest follow the brush.`}
            </p>
            {editor.eraserOverrideCount > 0 && (
              <button className="btn" onClick={() => editor.relinkEraser()}>
                Follow brush
              </button>
            )}
          </div>
        )}
        <Slider
          label="Size" value={b.size} min={1} max={400} gamma={2.4} step={0.1} defaultValue={34}
          format={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} px`}
          onChange={(v) => editor.setBrush({ size: v })}
          {...link('size')}
        />
        <Slider
          label="Hardness" value={b.hardness * 100} min={0} max={100} step={1} defaultValue={55}
          format={pct} onChange={(v) => editor.setBrush({ hardness: v / 100 })}
          {...link('hardness')}
        />
        <Slider
          label="Opacity" value={b.opacity * 100} min={1} max={100} step={1} defaultValue={100}
          format={pct} onChange={(v) => editor.setBrush({ opacity: v / 100 })}
          {...link('opacity')}
        />
        <Slider
          label="Flow" value={b.flow * 100} min={1} max={100} gamma={1.7} step={1} defaultValue={55}
          format={pct} onChange={(v) => editor.setBrush({ flow: v / 100 })}
          {...link('flow')}
        />
        <Slider
          label="Spacing" value={b.spacing * 100} min={1} max={50} gamma={1.6} step={1} defaultValue={6}
          format={pct} onChange={(v) => editor.setBrush({ spacing: v / 100 })}
          {...link('spacing')}
        />
      </div>

      <div className="sec">
        <h2>Pen dynamics</h2>
        {check('d-size', 'Pressure → size', 'pressureToSize')}
        {/* The curve only appears once the dynamic is on — an unreachable
            control is worse than an absent one. */}
        {b.pressureToSize && (
          <CurveEditor
            value={b.sizeCurve}
            onChange={(sizeCurve) => editor.setBrush({ sizeCurve })}
          />
        )}

        {check('d-flow', 'Pressure → flow', 'pressureToFlow')}
        {b.pressureToFlow && (
          <CurveEditor
            value={b.flowCurve}
            onChange={(flowCurve) => editor.setBrush({ flowCurve })}
          />
        )}

        {check('d-opac', 'Pressure → opacity', 'pressureToOpacity')}
        {b.pressureToOpacity && (
          <CurveEditor
            value={b.opacityCurve}
            onChange={(opacityCurve) => editor.setBrush({ opacityCurve })}
          />
        )}

        <Slider
          label="Min size" value={b.minSize * 100} min={0} max={100} step={1} defaultValue={8}
          format={pct} onChange={(v) => editor.setBrush({ minSize: v / 100 })}
          {...link('minSize')}
        />
        {check('d-tilt', 'Tilt → size (flatten)', 'tiltToSize')}
      </div>

      <div className="sec">
        <h2>Stroke</h2>
        <Slider
          label="Stabiliser" value={b.stabilise * 100} min={0} max={95} step={1} defaultValue={35}
          format={pct} onChange={(v) => editor.setBrush({ stabilise: v / 100 })}
          {...link('stabilise')}
        />
        <Slider
          label="Ease off at speed" value={b.stabiliseSpeedAdapt * 100} min={0} max={100} step={1}
          defaultValue={60} format={(v) => (v === 0 ? 'off' : pct(v))}
          onChange={(v) => editor.setBrush({ stabiliseSpeedAdapt: v / 100 })}
          {...link('stabiliseSpeedAdapt')}
        />
        <Slider
          label="Curve smoothing" value={b.pathSmoothness * 100} min={0} max={100} step={1}
          defaultValue={100} format={(v) => (v === 0 ? 'polyline' : pct(v))}
          onChange={(v) => editor.setBrush({ pathSmoothness: v / 100 })}
          {...link('pathSmoothness')}
        />
        {check('d-speed', 'Speed → size (taper)', 'speedToSize')}
      </div>
      </FloatingPanel>

      <FloatingPanel id="color-panel" title="Colour" initialTop={10} initialRight={240}>
        <ColorPicker
          color={b.color}
          onChange={(hex) => editor.setBrush({ color: hex })}
          showTitle={false}
        />
      </FloatingPanel>

      <FloatingPanel
        id="layers-panel"
        title="Layers"
        initialTop={367}
        initialRight={240}
        initialHeight={320}
      >
        <LayersPanel showTitle={false} />
        <div className="sec">
          <h2>Layer fill</h2>
          <div className="btn-row">
            <button className="btn" onClick={() => editor.clearLayer(undefined, '#ffffff')}>White</button>
            <button className="btn" onClick={() => editor.clearLayer(undefined, '#f2ece0')}>Paper</button>
            <button className="btn" onClick={() => editor.clearLayer()}>Clear</button>
          </div>
        </div>
      </FloatingPanel>
    </>
  )
}
