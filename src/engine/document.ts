import { Surface } from './surface'
import type { BlendMode } from './types'
import { clamp } from './types'

let nextId = 1

export class Layer {
  readonly id: number
  name: string
  surface: Surface
  opacity = 1
  blend: BlendMode = 'normal'
  visible = true
  /** Locked layers reject paint. Not enforced by Surface — the tools check it. */
  locked = false

  constructor(width: number, height: number, name?: string) {
    this.id = nextId++
    this.surface = new Surface(width, height)
    this.name = name ?? `Layer ${this.id}`
  }
}

export class PaintDocument {
  readonly width: number
  readonly height: number
  layers: Layer[] = []
  activeIndex = 0

  /** Bumped whenever the stack changes shape or a non-active layer is edited,
   *  so the compositor knows to rebuild its cached prefix. */
  structureVersion = 0

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.layers.push(new Layer(width, height, 'Background'))
  }

  get active(): Layer {
    return this.layers[clamp(this.activeIndex, 0, this.layers.length - 1)]
  }

  /** Index 0 is the BOTTOM of the stack, matching paint order. The layers panel
   *  reverses this for display, the way every art app does. */
  addLayer(name?: string, above = this.activeIndex): Layer {
    const layer = new Layer(this.width, this.height, name)
    this.layers.splice(above + 1, 0, layer)
    this.activeIndex = above + 1
    this.structureVersion++
    return layer
  }

  insertLayer(layer: Layer, index: number): void {
    this.layers.splice(clamp(index, 0, this.layers.length), 0, layer)
    this.activeIndex = clamp(index, 0, this.layers.length - 1)
    this.structureVersion++
  }

  removeLayer(index: number): Layer | null {
    if (this.layers.length <= 1) return null
    const [gone] = this.layers.splice(index, 1)
    this.activeIndex = clamp(this.activeIndex, 0, this.layers.length - 1)
    this.structureVersion++
    return gone ?? null
  }

  moveLayer(from: number, to: number): void {
    const t = clamp(to, 0, this.layers.length - 1)
    if (from === t) return
    const [l] = this.layers.splice(from, 1)
    if (!l) return
    this.layers.splice(t, 0, l)
    this.activeIndex = t
    this.structureVersion++
  }

  indexOf(layer: Layer): number {
    return this.layers.indexOf(layer)
  }

  touch(): void {
    this.structureVersion++
  }
}
