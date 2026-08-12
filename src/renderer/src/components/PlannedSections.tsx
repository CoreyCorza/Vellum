import { Slider } from './Slider'

const noop = (): void => undefined
const pct = (v: number): string => `${Math.round(v)}%`
const deg = (v: number): string => `${Math.round(v)}°`
const count = (v: number): string => String(Math.round(v))

/**
 * The shape of the brush engine still to be built.
 *
 * Sketches: every control is inert, and the category that holds them is marked
 * "planned". They exist so the layout can be judged at full size before anything is
 * wired up — a settings panel is mostly a question of what sits beside what, and
 * that is not answerable from a list of feature names.
 *
 * The four are the axes a charcoal or bristle brush actually needs: the shape of one
 * dab, how that shape turns along the stroke, the grain multiplied over it, and how
 * many marks get thrown around the path.
 */
export function TipBody(): JSX.Element {
  return (
    <>
      <div className="seg-row">
        <button className="btn" aria-pressed>
          Round
        </button>
        <button className="btn">Square</button>
        <button className="btn">Image…</button>
      </div>
      <Slider label="Roundness" value={100} min={5} max={100} step={1} defaultValue={100} format={pct} onChange={noop} />
      <Slider label="Angle" value={0} min={-180} max={180} step={1} defaultValue={0} format={deg} onChange={noop} />
      <Slider label="Spikes" value={2} min={2} max={12} step={1} defaultValue={2} format={count} onChange={noop} />
      <Slider label="Softness falloff" value={50} min={0} max={100} step={1} defaultValue={50} format={pct} onChange={noop} />
    </>
  )
}

export function RotationBody(): JSX.Element {
  return (
    <>
      <label className="chk">
        <input type="checkbox" readOnly />
        Follow stroke direction
      </label>
      <label className="chk">
        <input type="checkbox" readOnly />
        Follow pen twist
      </label>
      <label className="chk">
        <input type="checkbox" readOnly />
        Follow pen tilt
      </label>
      <Slider label="Fixed angle" value={0} min={-180} max={180} step={1} defaultValue={0} format={deg} onChange={noop} />
      <Slider label="Angle jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
    </>
  )
}

export function TextureBody(): JSX.Element {
  return (
    <>
      <div className="seg-row">
        <button className="btn">Choose pattern…</button>
      </div>
      <Slider label="Scale" value={100} min={10} max={400} gamma={1.6} step={1} defaultValue={100} format={pct} onChange={noop} />
      <Slider label="Depth" value={50} min={0} max={100} step={1} defaultValue={50} format={pct} onChange={noop} />
      <Slider label="Contrast" value={50} min={0} max={100} step={1} defaultValue={50} format={pct} onChange={noop} />
      <Slider label="Depth jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
      <label className="chk">
        <input type="checkbox" readOnly />
        Invert
      </label>
      <label className="chk">
        <input type="checkbox" readOnly />
        Texture each dab separately
      </label>
    </>
  )
}

export function ScatterBody(): JSX.Element {
  return (
    <>
      <Slider label="Count" value={1} min={1} max={16} step={1} defaultValue={1} format={count} onChange={noop} />
      <Slider label="Spread" value={0} min={0} max={200} step={1} defaultValue={0} format={pct} onChange={noop} />
      <Slider label="Count jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
      <Slider label="Size jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
      <label className="chk">
        <input type="checkbox" readOnly />
        Scatter along the stroke only
      </label>
    </>
  )
}
