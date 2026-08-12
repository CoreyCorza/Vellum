import { Slider } from './Slider'
import { Section } from './Section'

const noop = (): void => undefined
const pct = (v: number): string => `${Math.round(v)}%`
const deg = (v: number): string => `${Math.round(v)}°`

/**
 * The shape of the brush engine still to be built.
 *
 * These are sketches: every control is inert and every header says "planned". They
 * are here so the layout can be judged at full size before any of it is wired up —
 * a settings panel is mostly a question of what sits next to what, and that is not
 * answerable from a list of feature names.
 *
 * The four categories are the axes a charcoal or bristle brush actually needs: the
 * shape of one dab, how that shape is turned along the stroke, the grain multiplied
 * over it, and how many marks get thrown around the path.
 */
export function PlannedSections(): JSX.Element {
  return (
    <>
      <Section id="tip" title="Brush tip" summary="round" planned>
        <div className="seg-row">
          <button className="btn" aria-pressed>
            Round
          </button>
          <button className="btn">Square</button>
          <button className="btn">Image…</button>
        </div>
        <Slider label="Roundness" value={100} min={5} max={100} step={1} defaultValue={100} format={pct} onChange={noop} />
        <Slider label="Angle" value={0} min={-180} max={180} step={1} defaultValue={0} format={deg} onChange={noop} />
        <Slider label="Spikes" value={2} min={2} max={12} step={1} defaultValue={2} format={(v) => String(Math.round(v))} onChange={noop} />
      </Section>

      <Section id="rotation" title="Rotation" summary="fixed" planned>
        <label className="chk">
          <input type="checkbox" readOnly />
          Follow stroke direction
        </label>
        <label className="chk">
          <input type="checkbox" readOnly />
          Follow pen twist
        </label>
        <Slider label="Fixed angle" value={0} min={-180} max={180} step={1} defaultValue={0} format={deg} onChange={noop} />
        <Slider label="Angle jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
      </Section>

      <Section id="texture" title="Texture" summary="none" planned>
        <div className="seg-row">
          <button className="btn">Choose pattern…</button>
        </div>
        <Slider label="Scale" value={100} min={10} max={400} gamma={1.6} step={1} defaultValue={100} format={pct} onChange={noop} />
        <Slider label="Depth" value={50} min={0} max={100} step={1} defaultValue={50} format={pct} onChange={noop} />
        <Slider label="Contrast" value={50} min={0} max={100} step={1} defaultValue={50} format={pct} onChange={noop} />
        <label className="chk">
          <input type="checkbox" readOnly />
          Invert
        </label>
      </Section>

      <Section id="scatter" title="Scatter" summary="off" planned>
        <Slider label="Count" value={1} min={1} max={16} step={1} defaultValue={1} format={(v) => String(Math.round(v))} onChange={noop} />
        <Slider label="Spread" value={0} min={0} max={200} step={1} defaultValue={0} format={pct} onChange={noop} />
        <Slider label="Count jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
        <Slider label="Size jitter" value={0} min={0} max={100} step={1} defaultValue={0} format={pct} onChange={noop} />
      </Section>
    </>
  )
}
