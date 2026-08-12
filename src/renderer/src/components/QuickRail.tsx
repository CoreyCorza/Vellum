import { useEditorState } from '../useEditor'
import { FloatingPanel } from './FloatingPanel'
import { RailSlider } from './RailSlider'

/**
 * The quick rail: size, opacity, eyedropper, undo and redo in one narrow strip.
 *
 * Borrowed from Procreate, where the two things you reach for most often while
 * actually drawing sit under your off hand and need no panel open. Everything here
 * is a duplicate of a control that exists elsewhere — that is the point. It is a
 * shortcut, not a home, so it is off by default and toggled from the Panels menu.
 *
 * Size sits above opacity because it is adjusted far more often, and both fill from
 * the bottom so bigger reads as taller.
 */
export function QuickRail(): JSX.Element {
  const editor = useEditorState()
  const b = editor.brush

  return (
    <FloatingPanel
      id="quick-rail"
      title="Quick"
      initialTop={120}
      initialRight={1180}
      initialHeight={420}
      initialWidth={46}
      minWidth={40}
    >
      <div className="quickrail">
        <RailSlider
          label="Size"
          value={b.size}
          range={{ min: 1, max: 400, gamma: 2.4, step: 0.1 }}
          format={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} px`}
          onChange={(size) => editor.setBrush({ size })}
          onScrubStart={() => editor.showBrushPreview()}
          onScrubEnd={() => editor.hideBrushPreview()}
        />

        {/* Procreate's square between the sliders opens its colour picker, so this
            is the eyedropper. It is a toggle rather than a one-shot because the
            tool itself is modal, and pressing it again should put the brush back. */}
        <button
          className={'quickrail-btn' + (editor.tool === 'picker' ? ' on' : '')}
          aria-pressed={editor.tool === 'picker'}
          title="Pick a colour from the canvas (I)"
          onClick={() => editor.setTool(editor.tool === 'picker' ? 'brush' : 'picker')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect
              x="2.5"
              y="2.5"
              width="9"
              height="9"
              rx="2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        </button>

        <RailSlider
          label="Opacity"
          value={b.opacity * 100}
          range={{ min: 1, max: 100, step: 1 }}
          format={(v) => `${Math.round(v)}%`}
          onChange={(v) => editor.setBrush({ opacity: v / 100 })}
          onScrubStart={() => editor.showBrushPreview()}
          onScrubEnd={() => editor.hideBrushPreview()}
        />

        <div className="quickrail-foot">
          <button
            className="quickrail-btn"
            disabled={!editor.history.canUndo}
            title="Undo (Ctrl+Z)"
            onClick={() => editor.undo()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M4 4.5H8.6a3 3 0 0 1 0 6H5M4 4.5 6.2 2.4M4 4.5 6.2 6.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="quickrail-btn"
            disabled={!editor.history.canRedo}
            title="Redo (Ctrl+Shift+Z)"
            onClick={() => editor.redo()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M10 4.5H5.4a3 3 0 0 0 0 6H9M10 4.5 7.8 2.4M10 4.5 7.8 6.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </FloatingPanel>
  )
}
