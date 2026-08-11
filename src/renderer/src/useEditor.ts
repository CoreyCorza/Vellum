import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Editor } from '@engine/editor'

export const EditorContext = createContext<Editor | null>(null)

export function useEditor(): Editor {
  const e = useContext(EditorContext)
  if (!e) throw new Error('useEditor must be used inside <EditorContext.Provider>')
  return e
}

/**
 * Re-render when panel-relevant state changes.
 *
 * Deliberately NOT wired to pointer traffic — the editor keeps that on a
 * separate channel. A pen reporting at 240 Hz must never be able to schedule
 * 240 React renders a second.
 */
export function useEditorState(): Editor {
  const editor = useEditor()
  useSyncExternalStore(editor.ui.subscribe, editor.ui.getVersion, editor.ui.getVersion)
  return editor
}

/** Opt in to the throttled (~15 Hz) pen telemetry channel. Status bar only. */
export function useTelemetry(): Editor {
  const editor = useEditor()
  useSyncExternalStore(
    editor.telemetryChannel.subscribe,
    editor.telemetryChannel.getVersion,
    editor.telemetryChannel.getVersion
  )
  return editor
}
