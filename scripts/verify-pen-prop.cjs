/**
 * Confirms the MicrosoftTabletPenServiceProperty window property is actually
 * set on our HWND, by reading it back with GetPropW.
 *
 * This proves the FFI plumbing works and the flags landed on the right window.
 * It does NOT prove the rings disappear — that needs a pen on real hardware.
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const koffi = require('koffi')

// NOTE: do not require out/main/index.js here — it is the real app bootstrap
// and would spawn a second window and never exit.
const TABLET_DISABLE_PRESSANDHOLD = 0x00000001
const TABLET_DISABLE_PENTAPFEEDBACK = 0x00000008
const TABLET_DISABLE_PENBARRELFEEDBACK = 0x00000010
const TABLET_DISABLE_FLICKS = 0x00010000
const EXPECTED =
  TABLET_DISABLE_PRESSANDHOLD |
  TABLET_DISABLE_PENTAPFEEDBACK |
  TABLET_DISABLE_PENBARRELFEEDBACK |
  TABLET_DISABLE_FLICKS

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 400, show: false })

  const user32 = koffi.load('user32.dll')
  const SetPropW = user32.func('__stdcall', 'SetPropW', 'bool', ['void *', 'str16', 'void *'])
  const GetPropW = user32.func('__stdcall', 'GetPropW', 'void *', ['void *', 'str16'])
  const EnumChildProc = koffi.proto('bool __stdcall VerifyEnumChildProc(void *hwnd, void *lParam)')
  const EnumChildWindows = user32.func('__stdcall', 'EnumChildWindows', 'bool', [
    'void *', koffi.pointer(EnumChildProc), 'void *'
  ])

  const buf = win.getNativeWindowHandle()
  const hwndValue = buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
  const hwnd = koffi.address(Number(hwndValue))

  const result = {
    pointerSize: buf.length,
    hwnd: '0x' + hwndValue.toString(16),
    expectedFlags: '0x' + EXPECTED.toString(16),
    setOk: false,
    readBack: null,
    matches: false
  }

  try {
    const NAME = 'MicrosoftTabletPenServiceProperty'
    const value = koffi.address(EXPECTED)
    const readBack = (h) => {
      const got = GetPropW(h, NAME)
      return got === null ? 0 : Number(koffi.address(got))
    }

    result.setOk = Boolean(SetPropW(hwnd, NAME, value))
    const gotNum = readBack(hwnd)
    result.readBack = '0x' + gotNum.toString(16)
    result.matches = gotNum === EXPECTED

    // Chromium renders into CHILD windows, and those are what the tablet
    // service inspects. Setting only the frame — the first version of this
    // patch — provably did nothing.
    win.show()
    await new Promise((r) => setTimeout(r, 800))
    let children = 0
    let childrenMatching = 0
    const cb = koffi.register((child) => {
      children++
      if (SetPropW(child, NAME, value) && readBack(child) === EXPECTED) childrenMatching++
      return true
    }, koffi.pointer(EnumChildProc))
    try {
      EnumChildWindows(hwnd, cb, null)
    } finally {
      koffi.unregister(cb)
    }
    result.children = children
    result.childrenMatching = childrenMatching
  } catch (e) {
    result.error = String(e)
  }

  result.failed = !(
    result.setOk && result.matches &&
    result.children > 0 && result.children === result.childrenMatching
  )
  console.log('PENPROP ' + JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
