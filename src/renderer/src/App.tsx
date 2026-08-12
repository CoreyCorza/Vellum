import { useEffect, useMemo, useRef, useState } from 'react'
import { Editor } from '@engine/editor'
import { EditorContext } from './useEditor'
import { Stage } from './components/Stage'
import { Rail } from './components/Rail'
import { BrushPanel } from './components/BrushPanel'
import { StatusBar } from './components/StatusBar'
import { MenuBar } from './components/MenuBar'
import { CanvasBar } from './components/CanvasBar'
import { SettingsDialog } from './components/SettingsDialog'
import { loadPrefs, savePrefs } from './prefs'
import { PanelVisibilityProvider } from './panels'
import { QuickRail } from './components/QuickRail'
import { savePng } from './platform'
import { clamp, type ToolId } from '@engine/types'
import type { Modifiers } from '@engine/input'

const DOC_WIDTH = 2048
const DOC_HEIGHT = 1400

export function App(): JSX.Element {
  const editor = useMemo(() => new Editor(DOC_WIDTH, DOC_HEIGHT), [])
  // Mutable so the pointer layer reads live values without re-binding listeners.
  const mods = useRef<Modifiers>({ space: false, alt: false, ctrl: false }).current

  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // A ref, not the state itself: the keyboard effect is bound once and would
  // otherwise close over a stale value.
  const uiBlocked = useRef(false)
  useEffect(() => {
    uiBlocked.current = openMenu !== null || settingsOpen
  }, [openMenu, settingsOpen])

  // Stored preferences are applied to the engine once, at startup. The engine
  // never reads storage itself — see prefs.ts.
  useEffect(() => {
    const prefs = loadPrefs()
    editor.setCursorStyle(prefs.cursorStyle)
    editor.setCanvasScalingMode(prefs.canvasScalingMode)
    editor.restoreEraserBrush(prefs.eraserBrush)
  }, [editor])

  /**
   * Persist the eraser preset whenever it changes.
   *
   * One subscription rather than a save call in each control: the eraser can be
   * edited by every slider, checkbox and curve in the panel and by Alt+RMB size
   * scrubbing, and a control that forgot to save would be occasional silent loss.
   */
  useEffect(() => {
    let last = JSON.stringify(editor.eraserBrush)
    return editor.ui.subscribe(() => {
      const now = JSON.stringify(editor.eraserBrush)
      if (now === last) return
      last = now
      savePrefs({ eraserBrush: editor.eraserBrush })
    })
  }, [editor])

  const onExport = async (): Promise<void> => {
    await savePng(await editor.exportPNG())
  }

  useEffect(() => {
    /**
     * True only for real text entry.
     *
     * The obvious `t instanceof HTMLInputElement` is wrong and was a live bug:
     * a checkbox is an HTMLInputElement, so a focused checkbox made the
     * shortcut handler bail out entirely — space never reached the canvas and
     * the browser was left free to toggle the box instead.
     */
    const isTextEntry = (t: EventTarget | null): boolean => {
      if (t instanceof HTMLTextAreaElement) return true
      if (t instanceof HTMLInputElement) {
        return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file'].includes(t.type)
      }
      return t instanceof HTMLElement && t.isContentEditable
    }

    /**
     * Keyboard focus belongs to the canvas unless you are typing.
     *
     * Clicking any widget leaves it focused, after which the browser keeps
     * routing keys to it — space re-toggles the last checkbox, enter re-fires
     * the last button. Dropping focus after activation kills that whole class
     * of bug rather than patching it key by key.
     *
     * `<select>` is excluded: its dropdown is an OS popup and blurring while
     * it is open would close it. It gets blurred on `change` instead.
     */
    const dropFocus = (): void => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return
      if (active === document.body) return
      if (isTextEntry(active) || active instanceof HTMLSelectElement) return
      active.blur()
    }
    const onChange = (e: Event): void => {
      if (e.target instanceof HTMLSelectElement) e.target.blur()
    }

    /**
     * Spring-loaded eraser state.
     *
     * E does two jobs and which one is meant is only knowable on release: tap it
     * and you want to switch tools, hold it and erase and you want to go back
     * where you were. Rather than a timing threshold — which always feels wrong
     * to somebody — the test is whether the eraser was actually USED while the
     * key was down. Drawing while holding is what makes it temporary; that is
     * the intent, stated by the hand rather than by a stopwatch.
     */
    let spring: { from: ToolId; strokes: number } | null = null

    const down = (e: KeyboardEvent): void => {
      if (isTextEntry(e.target)) return
      // A menu or dialog owns the keyboard while it is open, so `e` doesn't
      // switch tools behind a Settings panel. Escape is handled by whichever
      // surface is showing.
      if (uiBlocked.current) return
      const k = e.key.toLowerCase()

      // Modifier state is updated BEFORE the shortcut branch returns — the
      // ctrl+space+drag zoom needs both flags live, and an early return here
      // would mean space never registers while ctrl is held.
      if (e.code === 'Space') {
        mods.space = true
        // preventDefault alone is not enough insurance here — buttons and
        // checkboxes activate on keyUP, so also strip focus outright.
        e.preventDefault()
        dropFocus()
      }
      mods.alt = e.altKey
      mods.ctrl = e.ctrlKey || e.metaKey

      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) editor.redo()
          else editor.undo()
        } else if (k === 'y') {
          e.preventDefault()
          editor.redo()
        } else if (k === 's') {
          e.preventDefault()
          void onExport()
        }
        return
      }

      // Hold S and move the pen to resize — hovering or in contact, no button.
      // This is the barrel-free path: a pen button mapped to right-click makes
      // Windows Ink draw its own ring under the nib that no app can suppress.
      // `repeat` matters — key auto-repeat would otherwise re-arm every tick and
      // reset the anchor.
      if (k === 's' && !e.repeat && editor.cursor.visible) {
        editor.beginSizeScrub(editor.cursor.x, editor.cursor.y, 'keys')
        e.preventDefault()
        return
      }

      switch (k) {
        case 'b': editor.setTool('brush'); break
        case 'e':
          // Auto-repeat must not re-arm the spring, or the remembered tool
          // becomes 'eraser' a tick after the key goes down and releasing has
          // nothing to return to.
          if (!e.repeat) {
            spring = { from: editor.tool, strokes: editor.strokesCommitted }
            if (editor.tool !== 'eraser') editor.setTool('eraser')
          }
          break
        case 'i': editor.setTool('picker'); break
        case '[': editor.setBrush({ size: Math.max(1, editor.brush.size * 0.85) }); break
        case ']': editor.setBrush({ size: Math.min(400, editor.brush.size * 1.18 + 1) }); break
        case 'f':
          editor.camera.fit(editor.doc.width, editor.doc.height)
          editor.invalidate()
          break
        case '0':
          editor.camera.fit(editor.doc.width, editor.doc.height)
          editor.invalidate()
          break
        case '1':
          editor.camera.scale = 1
          editor.camera.rotation = 0
          editor.invalidate()
          break
        case 'n':
          if (e.shiftKey) editor.addLayer()
          break
        case 'm': {
          const modes = ['none', 'x', 'y', 'xy'] as const
          const i = modes.indexOf(editor.brush.symmetry)
          editor.setBrush({ symmetry: modes[(i + 1) % modes.length] })
          break
        }
        default:
          break
      }
    }

    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') mods.space = false
      if (e.key.toLowerCase() === 's') editor.endSizeScrub('keys')

      if (e.key.toLowerCase() === 'e' && spring) {
        const used = editor.strokesCommitted > spring.strokes
        if (used) {
          // Held and erased: temporary. Go back to whatever was in hand.
          if (spring.from !== 'eraser') editor.setTool(spring.from)
        } else if (spring.from === 'eraser') {
          // Tapped while already erasing: the second half of a toggle.
          editor.setTool('brush')
        }
        // Tapped from the brush without erasing: stay on the eraser.
        spring = null
      }

      mods.alt = e.altKey
      mods.ctrl = e.ctrlKey || e.metaKey
    }

    // Alt-tabbing away swallows the keyup, which otherwise leaves a modifier
    // stuck on and the next click doing something unexpected.
    const blur = (): void => {
      mods.space = false
      mods.alt = false
      mods.ctrl = false
      editor.endSizeScrub('keys')
      // The keyup will never arrive. Disarm rather than revert: changing tools
      // while the window is not focused would be a surprise on the way back.
      spring = null
    }

    // Suppress the pen press-and-hold context menu everywhere except text
    // fields, so resting the nib on a control never pops a menu mid-gesture.
    const ctx = (e: MouseEvent): void => {
      if (!isTextEntry(e.target)) e.preventDefault()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    window.addEventListener('contextmenu', ctx)
    // `click` rather than `pointerup`, so the control finishes activating first.
    window.addEventListener('click', dropFocus)
    window.addEventListener('change', onChange, true)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      window.removeEventListener('contextmenu', ctx)
      window.removeEventListener('click', dropFocus)
      window.removeEventListener('change', onChange, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Keep zoom sane if the window is resized to something extreme.
  useEffect(() => {
    editor.camera.scale = clamp(editor.camera.scale, 0.02, 64)
  }, [editor])

  // Debug handle for the console and for scripts/verify.cjs. Dev builds always
  // get it; production only with ?debug, so it isn't sitting in a shipped app.
  useEffect(() => {
    if (import.meta.env.DEV || location.search.includes('debug')) {
      ;(window as unknown as { editor: Editor }).editor = editor
    }
  }, [editor])

  return (
    <EditorContext.Provider value={editor}>
      <PanelVisibilityProvider>
      <MenuBar
        open={openMenu}
        onOpenChange={setOpenMenu}
        onExport={() => void onExport()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/*
        #workspace is the positioning context for everything that floats. Both
        Rail and FloatingPanel constrain themselves to `parentElement`, so
        putting them here — rather than directly in #root — is what keeps them
        from sliding under the menu bar or the status bar.
      */}
      <div id="workspace">
        <Stage mods={mods} />
        <CanvasBar />
        <Rail onExport={() => void onExport()} />
        <BrushPanel />
        <QuickRail />
      </div>
      <StatusBar />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </PanelVisibilityProvider>
    </EditorContext.Provider>
  )
}
