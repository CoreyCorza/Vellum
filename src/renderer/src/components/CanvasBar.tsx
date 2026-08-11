import { useEditorState } from '../useEditor'
import type { SymmetryMode } from '@engine/brush/settings'

/**
 * Fixed options bar pinned to the top of the canvas.
 *
 * Unlike the floating panels this cannot be moved — it is the place for
 * controls you reach for constantly and want in a predictable spot. It sits
 * inside #workspace, so it never overlaps the menu bar or the status bar.
 *
 * It intercepts pen input for free: the canvas hit-test in gestures.ts asks
 * `document.elementFromPoint`, so pressing on this bar cannot start a stroke on
 * the canvas underneath.
 */
export function CanvasBar(): JSX.Element {
  const editor = useEditorState()
  const symmetry = editor.brush.symmetry

  const modes: { id: SymmetryMode; label: string; title: string }[] = [
    { id: 'none', label: 'Off', title: 'No symmetry (M cycles)' },
    { id: 'x', label: 'X', title: 'Mirror across the vertical centre line' },
    { id: 'y', label: 'Y', title: 'Mirror across the horizontal centre line' },
    { id: 'xy', label: 'XY', title: 'Mirror both axes (4-way)' }
  ]

  return (
    <div id="canvasbar">
      <span className="cbar-label">Symmetry</span>
      <div className="cbar-group">
        {modes.map((m) => (
          <button
            key={m.id}
            className="cbar-btn"
            title={m.title}
            aria-pressed={symmetry === m.id}
            onClick={() => editor.setBrush({ symmetry: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  )
}
