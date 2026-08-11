import type { BrowserWindow } from 'electron'

/**
 * Suppress Windows Ink's on-screen pen feedback for a window.
 *
 * Windows draws its own visuals under the nib — the expanding ring on tap, and
 * the ring that appears when you hold the barrel button — before the app sees
 * anything. They are painted by the OS, not by us, so no amount of CSS or
 * canvas work removes them.
 *
 * The documented escape is a window property named
 * `MicrosoftTabletPenServiceProperty`, whose value is a bitmask of behaviours to
 * turn off. It predates Windows Ink and is what WPF and other native apps use.
 * Electron exposes no API for it, hence the FFI call to SetPropW.
 *
 * Non-fatal by design: if anything here fails the app runs normally, just with
 * the OS rings still visible.
 */

// winuser.h
const TABLET_DISABLE_PRESSANDHOLD = 0x00000001
const TABLET_DISABLE_PENTAPFEEDBACK = 0x00000008
const TABLET_DISABLE_PENBARRELFEEDBACK = 0x00000010
const TABLET_DISABLE_FLICKS = 0x00010000

const FLAGS =
  TABLET_DISABLE_PRESSANDHOLD |   // no press-and-hold -> right-click gesture
  TABLET_DISABLE_PENTAPFEEDBACK | // no ring on tap
  TABLET_DISABLE_PENBARRELFEEDBACK | // no ring on barrel button  <- the one you saw
  TABLET_DISABLE_FLICKS // no navigation flicks

const PROP_NAME = 'MicrosoftTabletPenServiceProperty'

export interface PenFeedbackResult {
  applied: boolean
  /** How many HWNDs the property landed on — top level plus every child. */
  windows: number
  reason?: string
  hwnd?: string
}

/**
 * Applies to the top-level window AND every child window.
 *
 * Chromium does not receive pen input on the top-level HWND. It renders into
 * child windows (`Chrome_RenderWidgetHostHWND` and friends), and the tablet
 * service looks up the property on the window actually under the pen. Setting
 * it only on the frame — which is what the first attempt did — therefore
 * achieves nothing, which matches the rings still appearing.
 */
/**
 * FFI bindings, built once.
 *
 * `koffi.proto` registers the callback type in a PROCESS-GLOBAL namespace, so
 * calling it a second time throws "Duplicate type name". Since this function
 * deliberately runs several times per window, the bindings have to be a
 * singleton.
 */
interface Bindings {
  koffi: typeof import('koffi')
  SetPropW: (hwnd: unknown, name: string, value: unknown) => boolean
  EnumChildWindows: (hwnd: unknown, cb: unknown, lparam: unknown) => boolean
  EnumChildProcPtr: import('koffi').TypeObject
}
let bindings: Bindings | null = null
let bindingsError: string | null = null

function getBindings(): Bindings | null {
  if (bindings) return bindings
  if (bindingsError) return null
  try {
    // Required lazily so a broken/absent native module cannot stop the app booting.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    // BOOL SetPropW(HWND, LPCWSTR, HANDLE)
    const SetPropW = user32.func('__stdcall', 'SetPropW', 'bool', ['void *', 'str16', 'void *'])
    const EnumChildProc = koffi.proto('bool __stdcall InkwellEnumChildProc(void *hwnd, void *lParam)')
    const EnumChildProcPtr = koffi.pointer(EnumChildProc)
    const EnumChildWindows = user32.func('__stdcall', 'EnumChildWindows', 'bool', [
      'void *',
      EnumChildProcPtr,
      'void *'
    ])
    bindings = { koffi, SetPropW, EnumChildWindows, EnumChildProcPtr }
    return bindings
  } catch (err) {
    bindingsError = err instanceof Error ? err.message : String(err)
    return null
  }
}

export function suppressPenFeedback(win: BrowserWindow): PenFeedbackResult {
  if (process.platform !== 'win32') return { applied: false, windows: 0, reason: 'not windows' }

  const b = getBindings()
  if (!b) return { applied: false, windows: 0, reason: bindingsError ?? 'bindings unavailable' }
  const { koffi, SetPropW, EnumChildWindows, EnumChildProcPtr } = b

  try {
    const buf = win.getNativeWindowHandle()
    // HWND is pointer-sized: 8 bytes on x64, 4 on x86.
    const hwndValue = buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
    const root = koffi.address(Number(hwndValue))
    const value = koffi.address(FLAGS)

    let count = 0
    const ok = SetPropW(root, PROP_NAME, value)
    if (ok) count++

    const cb = koffi.register((child: unknown) => {
      if (SetPropW(child, PROP_NAME, value)) count++
      return true // keep enumerating
    }, EnumChildProcPtr)
    try {
      EnumChildWindows(root, cb, null)
    } finally {
      koffi.unregister(cb)
    }

    return {
      applied: count > 0,
      windows: count,
      hwnd: `0x${hwndValue.toString(16)}`,
      reason: count > 0 ? undefined : 'SetPropW set nothing'
    }
  } catch (err) {
    return {
      applied: false,
      windows: 0,
      reason: err instanceof Error ? err.message : String(err)
    }
  }
}
