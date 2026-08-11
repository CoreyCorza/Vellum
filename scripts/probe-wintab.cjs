/**
 * Feasibility probe for a Wintab input backend.
 *
 * Wintab is the tablet driver's own API — the one Krita uses on Windows, and
 * the reason Krita needs no Windows Ink. It hands us raw packets (position,
 * pressure, tilt, button bits) with no WM_POINTER involvement, which also means
 * no OS-drawn pen feedback.
 *
 * This only reads capabilities. It opens no context and steals no input.
 *
 *   node scripts/probe-wintab.cjs
 */
const koffi = require('koffi')
const fs = require('node:fs')

// WTI_* categories
const WTI_INTERFACE = 1
const WTI_DEVICES = 100

// IFC_* indices
const IFC_WINTABID = 1
const IFC_SPECVERSION = 2
const IFC_IMPLVERSION = 3
const IFC_NDEVICES = 4
const IFC_NCURSORS = 5

// DVC_* indices
const DVC_NAME = 1
const DVC_HARDWARE = 2
const DVC_PKTRATE = 5
const DVC_X = 12
const DVC_Y = 13
const DVC_NPRESSURE = 15
const DVC_ORIENTATION = 17

const out = { dllPresent: false }

const dllPaths = [
  'C:\\Windows\\System32\\wintab32.dll',
  'C:\\Windows\\SysWOW64\\wintab32.dll'
]
out.dllFound = dllPaths.filter((p) => fs.existsSync(p))
out.dllPresent = out.dllFound.length > 0

try {
  const wt = koffi.load('wintab32.dll')
  const WTInfoW = wt.func('__stdcall', 'WTInfoW', 'uint', ['uint', 'uint', 'void *'])

  out.wintabAvailable = WTInfoW(0, 0, null) > 0

  const str = (cat, idx) => {
    const n = WTInfoW(cat, idx, null)
    if (!n) return null
    const buf = Buffer.alloc(n + 2)
    WTInfoW(cat, idx, buf)
    return buf.toString('utf16le').replace(/\0+$/, '')
  }
  const u32 = (cat, idx) => {
    const buf = Buffer.alloc(4)
    return WTInfoW(cat, idx, buf) ? buf.readUInt32LE(0) : null
  }
  const u16 = (cat, idx) => {
    const buf = Buffer.alloc(2)
    return WTInfoW(cat, idx, buf) ? buf.readUInt16LE(0) : null
  }
  // AXIS { LONG axMin; LONG axMax; UINT axUnits; FIX32 axResolution; }
  const axis = (cat, idx) => {
    const buf = Buffer.alloc(16)
    if (!WTInfoW(cat, idx, buf)) return null
    return {
      min: buf.readInt32LE(0),
      max: buf.readInt32LE(4),
      units: buf.readUInt32LE(8),
      resolution: buf.readUInt32LE(12)
    }
  }

  const spec = u16(WTI_INTERFACE, IFC_SPECVERSION)
  const impl = u16(WTI_INTERFACE, IFC_IMPLVERSION)
  out.interface = {
    id: str(WTI_INTERFACE, IFC_WINTABID),
    specVersion: spec === null ? null : `${spec >> 8}.${spec & 0xff}`,
    implVersion: impl === null ? null : `${impl >> 8}.${impl & 0xff}`,
    devices: u32(WTI_INTERFACE, IFC_NDEVICES),
    cursors: u32(WTI_INTERFACE, IFC_NCURSORS)
  }

  const nDev = out.interface.devices || 0
  out.devices = []
  for (let i = 0; i < nDev; i++) {
    const cat = WTI_DEVICES + i
    const press = axis(cat, DVC_NPRESSURE)
    out.devices.push({
      name: str(cat, DVC_NAME),
      hardwareBits: u32(cat, DVC_HARDWARE),
      packetRateHz: u32(cat, DVC_PKTRATE),
      x: axis(cat, DVC_X),
      y: axis(cat, DVC_Y),
      pressure: press,
      pressureLevels: press ? press.max - press.min + 1 : null,
      orientation: axis(cat, DVC_ORIENTATION)
    })
  }
} catch (e) {
  out.error = String(e)
}

console.log(JSON.stringify(out, null, 2))
