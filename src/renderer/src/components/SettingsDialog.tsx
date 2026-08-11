import { useEffect, useState } from 'react'
import { useEditorState } from '../useEditor'
import { setWintabEnabled, wintabStatus, type WintabStatus } from '../platform'
import { savePrefs } from '../prefs'
import { CURSOR_STYLES, type CursorStyle } from '@engine/types'

const TABS = ['Tablet', 'Cursor', 'Canvas', 'Appearance'] as const
type Tab = (typeof TABS)[number]

/** Little previews so the choice is visible rather than described. */
const CURSOR_PREVIEW: Record<CursorStyle, JSX.Element> = {
  brush: (
    <svg viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="12" className="cp-dark" strokeWidth="3" />
      <circle cx="20" cy="20" r="12" className="cp-light" strokeWidth="1" />
      <circle cx="20" cy="20" r="1.2" className="cp-fill" />
    </svg>
  ),
  dot: (
    <svg viewBox="0 0 40 40">
      <rect x="18.5" y="18.5" width="3" height="3" className="cp-darkfill" />
      <rect x="19.5" y="19.5" width="1" height="1" className="cp-fill" />
    </svg>
  ),
  crosshair: (
    <svg viewBox="0 0 40 40">
      <g className="cp-dark" strokeWidth="3">
        <path d="M9 20h6M25 20h6M20 9v6M20 25v6" />
      </g>
      <g className="cp-light" strokeWidth="1">
        <path d="M9 20h6M25 20h6M20 9v6M20 25v6" />
      </g>
    </svg>
  )
}

const CURSOR_LABEL: Record<CursorStyle, { name: string; blurb: string }> = {
  brush: {
    name: 'Brush outline',
    blurb: 'A circle matching the brush size on screen. Shows exactly what you are about to cover.'
  },
  dot: {
    name: 'Single pixel',
    blurb: 'One pixel and nothing else. Maximum view of the artwork, no indication of brush size.'
  },
  crosshair: {
    name: 'Crosshair',
    blurb: 'A small fixed crosshair. Stays the same size at any zoom or brush size.'
  }
}

/**
 * Global application settings.
 *
 * Tabbed rather than one long scroll, because these groups have nothing to do
 * with each other — you arrive looking for one of them specifically.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const editor = useEditorState()
  const [tab, setTab] = useState<Tab>('Tablet')

  // Tri-state: `undefined` is still loading, `null` means there is no Wintab
  // service to ask (browser mode, or a non-Windows build).
  const [status, setStatus] = useState<WintabStatus | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void wintabStatus().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleWintab = async (on: boolean): Promise<void> => {
    setBusy(true)
    // Turning it off simply stops the service forwarding samples. The engine
    // needs no rebinding: `wintabRecent` lapses within 250ms and the Pointer
    // Events path takes the pen back on its own.
    const next = await setWintabEnabled(on)
    setStatus(next ?? (await wintabStatus()))
    setBusy(false)
  }

  const chooseCursor = (style: CursorStyle): void => {
    editor.setCursorStyle(style)
    savePrefs({ cursorStyle: style })
  }

  const caps = status?.caps

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <span>Settings</span>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="modal-split">
          <nav className="modal-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                className="modal-tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>

          <div className="modal-panel" role="tabpanel" aria-label={tab}>
            {tab === 'Tablet' && (
              <>
                <div className="sec">
                  <h2>Pen input</h2>

                  {status === undefined && <p className="hint">Checking…</p>}

                  {status === null && (
                    <p className="hint">
                      No Wintab service available — running in the browser, or on a platform
                      where Pointer Events is already the right path. Pen pressure comes from
                      the browser.
                    </p>
                  )}

                  {status && !status.supported && (
                    <p className="hint">
                      Wintab unavailable{status.reason ? ` — ${status.reason}` : ''}. Using
                      Pointer Events.
                    </p>
                  )}

                  {status?.supported && (
                    <>
                      <label className="chk" htmlFor="wintab-on">
                        <input
                          id="wintab-on"
                          type="checkbox"
                          checked={status.active}
                          disabled={busy}
                          onChange={(e) => void toggleWintab(e.target.checked)}
                        />
                        Use Wintab for pen input
                      </label>
                      <p className="hint">
                        The tablet driver&apos;s own API — full pressure resolution, and it
                        keeps working with &ldquo;Use Windows Ink&rdquo; switched off. Turn this
                        off to fall back to Pointer Events.
                      </p>
                    </>
                  )}
                </div>

                {caps && (
                  <div className="sec">
                    <h2>Reporting</h2>
                    <table className="kv">
                      <tbody>
                        <tr>
                          <td>Device</td>
                          <td>{caps.device ?? '—'}</td>
                        </tr>
                        <tr>
                          <td>Pressure levels</td>
                          <td>{caps.pressureLevels.toLocaleString()}</td>
                        </tr>
                        <tr>
                          <td>Report rate</td>
                          <td>{caps.packetRate} Hz</td>
                        </tr>
                        <tr>
                          <td>Poll interval</td>
                          <td>{status?.pollMs} ms</td>
                        </tr>
                        <tr>
                          <td>1 ms timers</td>
                          <td>{status?.highResTimers ? 'on' : 'off'}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {tab === 'Cursor' && (
              <div className="sec">
                <h2>Canvas cursor</h2>
                <div className="cursor-grid">
                  {CURSOR_STYLES.map((style) => (
                    <button
                      key={style}
                      className="cursor-option"
                      aria-pressed={editor.cursorStyle === style}
                      onClick={() => chooseCursor(style)}
                    >
                      <span className="cursor-preview">{CURSOR_PREVIEW[style]}</span>
                      <span className="cursor-text">
                        <strong>{CURSOR_LABEL[style].name}</strong>
                        <span className="hint">{CURSOR_LABEL[style].blurb}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="hint">
                  The eyedropper always uses the system crosshair, and the brush outline
                  temporarily replaces any of these while resizing.
                </p>
              </div>
            )}

            {tab === 'Canvas' && (
              <div className="sec">
                <h2>Canvas</h2>
                <p className="hint">
                  Default document size and background are fixed for now — they arrive with the
                  document format.
                </p>
              </div>
            )}

            {tab === 'Appearance' && (
              <div className="sec">
                <h2>Appearance</h2>
                <p className="hint">Theme and UI scale are not built yet.</p>
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
