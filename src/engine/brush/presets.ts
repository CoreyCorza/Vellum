import { DEFAULT_BRUSH, type BrushSettings } from './settings'
import { gammaCurve } from './curve'

/**
 * A brush preset.
 *
 * Erasers are presets too. From the user's side an eraser is just a brush that
 * takes paint off, and people keep several — a hard one for cleaning edges, a
 * big soft one for knocking back a wash — so they belong on the same shelf as
 * everything else rather than in a separate cupboard.
 */
export interface BrushPreset {
  id: string
  name: string
  /** True if choosing this preset should put you in erase mode. */
  erase: boolean
  settings: Partial<BrushSettings>
  /**
   * A painted icon, as a data URL, replacing the generated stroke preview.
   *
   * Optional on purpose: a preset draws its own preview from its settings, so it
   * is never blank and never wrong, and painting an icon is something you do for
   * the few presets you care about rather than a chore blocking the feature.
   */
  icon?: string
}

export const BUILT_IN_PRESETS: BrushPreset[] = [
  {
    id: 'liner',
    name: 'Liner',
    erase: false,
    settings: {
      size: 2, hardness: 1, opacity: 1, flow: 1, spacing: 0.03,
      pressureToSize: true, pressureToOpacity: false, sizeCurve: gammaCurve(1.2),
      minSize: 0.15, stabilise: 0.5, speedToSize: false
    }
  },
  {
    id: 'ink',
    name: 'Ink',
    erase: false,
    settings: {
      size: 8, hardness: 0.92, opacity: 1, flow: 1, spacing: 0.03,
      pressureToSize: true, pressureToOpacity: false, sizeCurve: gammaCurve(1.4),
      minSize: 0.05, stabilise: 0.45, speedToSize: false
    }
  },
  {
    id: 'pencil',
    name: 'Pencil',
    erase: false,
    settings: {
      size: 5, hardness: 0.35, opacity: 0.75, flow: 0.35, spacing: 0.05,
      pressureToSize: true, pressureToOpacity: true,
      sizeCurve: gammaCurve(1.6), opacityCurve: gammaCurve(1.6),
      minSize: 0.25, stabilise: 0.2, speedToSize: false
    }
  },
  {
    id: 'marker',
    name: 'Marker',
    erase: false,
    settings: {
      size: 24, hardness: 0.75, opacity: 1, flow: 0.9, spacing: 0.04,
      pressureToSize: false, pressureToOpacity: false,
      minSize: 0.4, stabilise: 0.3, speedToSize: false
    }
  },
  {
    id: 'paint',
    name: 'Paint',
    erase: false,
    settings: {
      size: 52, hardness: 0.4, opacity: 1, flow: 0.5, spacing: 0.05,
      pressureToSize: true, pressureToOpacity: false, sizeCurve: gammaCurve(0.9),
      minSize: 0.15, stabilise: 0.3, speedToSize: false
    }
  },
  {
    id: 'wash',
    name: 'Wash',
    erase: false,
    settings: {
      size: 90, hardness: 0.15, opacity: 0.9, flow: 0.12, spacing: 0.03,
      pressureToSize: false, pressureToOpacity: true, opacityCurve: gammaCurve(1.6),
      minSize: 0.5, stabilise: 0.2, speedToSize: false
    }
  },
  {
    id: 'airbrush',
    name: 'Airbrush',
    erase: false,
    settings: {
      size: 120, hardness: 0, opacity: 0.9, flow: 0.06, spacing: 0.03,
      pressureToSize: false, pressureToOpacity: true, opacityCurve: gammaCurve(1.8),
      minSize: 0.6, stabilise: 0.15, speedToSize: false
    }
  },
  {
    id: 'eraser-precise',
    name: 'Eraser fine',
    erase: true,
    settings: {
      size: 6, hardness: 1, opacity: 1, flow: 1, spacing: 0.03,
      pressureToSize: true, pressureToOpacity: false, minSize: 0.2, stabilise: 0.4
    }
  },
  {
    id: 'eraser-hard',
    name: 'Eraser hard',
    erase: true,
    settings: {
      size: 34, hardness: 1, opacity: 1, flow: 1, spacing: 0.04,
      pressureToSize: false, pressureToOpacity: false, minSize: 0.5, stabilise: 0.25
    }
  },
  {
    id: 'eraser-soft',
    name: 'Eraser soft',
    erase: true,
    settings: {
      size: 80, hardness: 0, opacity: 1, flow: 0.25, spacing: 0.03,
      pressureToSize: false, pressureToOpacity: true, minSize: 0.5, stabilise: 0.2
    }
  }
]

/** Full settings for a preset — its own values over the defaults. */
export function presetSettings(p: BrushPreset): BrushSettings {
  return { ...DEFAULT_BRUSH, ...p.settings }
}

/**
 * Do these two settings differ in any way that belongs to a preset?
 *
 * Colour and symmetry are excluded because they are global — changing the colour
 * is not editing the brush, and a preset that counted it as a change would report
 * itself modified every time you picked a new one.
 */
export function settingsDiffer(a: BrushSettings, b: BrushSettings): boolean {
  const keys = Object.keys(DEFAULT_BRUSH) as (keyof BrushSettings)[]
  for (const k of keys) {
    if (k === 'color' || k === 'symmetry') continue
    const x = a[k]
    const y = b[k]
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return true
      for (let i = 0; i < x.length; i++) {
        if (x[i].x !== y[i].x || x[i].y !== y[i].y) return true
      }
      continue
    }
    if (typeof x === 'number' && typeof y === 'number') {
      if (Math.abs(x - y) > 1e-6) return true
      continue
    }
    if (x !== y) return true
  }
  return false
}
