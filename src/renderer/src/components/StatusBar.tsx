import { useTelemetry } from '../useEditor'

const MB = (bytes: number): string => `${(bytes / 1048576).toFixed(0)} MB`

export function StatusBar(): JSX.Element {
  const editor = useTelemetry()
  const t = editor.telemetry
  const isPen = t.pointerType === 'pen' || t.pointerType === 'wintab'

  return (
    <div id="status">
      <b>pen</b>
      <span
        id="ptype"
        className={isPen ? 'pen' : ''}
        title={
          "'wintab' = the tablet driver's own API, full pressure resolution, no Windows Ink needed. " +
          "'pen' = Windows Ink via Pointer Events (1024 pressure steps). " +
          "'mouse' = no pressure at all."
        }
      >
        {t.pointerType}
      </span>

      <b>P</b>
      <div className="meter">
        <i style={{ width: `${t.pressure * 100}%` }} />
      </div>
      <span>{t.pressure.toFixed(2)}</span>

      <b>tilt</b>
      <span>
        {t.tiltX | 0}°/{t.tiltY | 0}°
      </span>
      <b>twist</b>
      <span>{t.twist | 0}°</span>

      <div className="st-spacer" />

      <b>layers</b>
      <span>{editor.doc.layers.length}</span>
      <b>undo</b>
      <span title={`${editor.history.depth} steps retained`}>
        {MB(editor.history.retainedBytes)}
      </span>
      <b>pos</b>
      <span>
        {Math.round(t.docX)}, {Math.round(t.docY)}
      </span>
      <b>zoom</b>
      <span>{Math.round(editor.camera.scale * 100)}%</span>
      <b>rot</b>
      <span>{Math.round(((editor.camera.rotation * 180) / Math.PI) % 360)}°</span>
      {/* Pan health: input travel vs document travel. Should read 1.00 while
          panning. Visible without devtools so a real-hardware mismatch can be
          reported as a number rather than a feeling. */}
      {editor.nav.debugInputTravel > 0 && (
        <>
          <b>pan</b>
          <span>
            {(editor.nav.debugDocTravel / Math.max(1e-6, editor.nav.debugInputTravel)).toFixed(2)}x
          </span>
        </>
      )}
      <b>hz</b>
      <span title="Coalesced pen samples per second reaching the brush engine">
        {t.rateHz || '—'}
      </span>
      <b>fps</b>
      {/* Frames are only drawn when something changed, so an idle app honestly
          renders zero. Showing 'idle' rather than '0' stops that reading as a
          stall. */}
      <span title="Rendered frames per second — the app redraws only on change">
        {t.fps > 0 ? t.fps : 'idle'}
      </span>
    </div>
  )
}
