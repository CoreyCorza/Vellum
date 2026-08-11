import type { Rect } from './types'
import type { Layer } from './document'
import type { Surface } from './surface'

export interface Command {
  readonly label: string
  /** Approximate retained bytes, for budgeting the stack. */
  readonly bytes: number
  undo(): void
  redo(): void
}

/**
 * A rectangular pixel edit.
 *
 * Patches are Surfaces, not ImageData — see `Surface.extract`. Keeping them on
 * the GPU is what makes undo capture cost nothing at pen-up.
 *
 * Only `before` is retained up front; `after` is captured lazily the first time
 * the command is undone. That halves the cost of the common case — a stroke you
 * never take back.
 */
export class PixelPatch implements Command {
  readonly bytes: number
  private after: Surface | null = null

  constructor(
    readonly label: string,
    private layer: Layer,
    private rect: Rect,
    private before: Surface
  ) {
    this.bytes = before.width * before.height * 4
  }

  undo(): void {
    if (!this.after) this.after = this.layer.surface.extract(this.rect)
    this.layer.surface.restore(this.before, this.rect.x, this.rect.y)
  }

  redo(): void {
    if (this.after) this.layer.surface.restore(this.after, this.rect.x, this.rect.y)
  }
}

/** Structural edits — add/remove/reorder/rename/opacity. Cheap, so no budgeting. */
export class ActionCommand implements Command {
  readonly bytes = 0
  constructor(
    readonly label: string,
    private _undo: () => void,
    private _redo: () => void
  ) {}
  undo(): void {
    this._undo()
  }
  redo(): void {
    this._redo()
  }
}

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private bytes = 0

  /** Soft cap on retained pixel data. Beyond it, the oldest entries are dropped. */
  budget = 768 * 1024 * 1024

  onChange: (() => void) | null = null

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
  get depth(): number {
    return this.undoStack.length
  }
  get retainedBytes(): number {
    return this.bytes
  }
  get nextUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null
  }

  push(cmd: Command): void {
    this.undoStack.push(cmd)
    this.bytes += cmd.bytes
    this.redoStack.length = 0
    while (this.bytes > this.budget && this.undoStack.length > 1) {
      const dropped = this.undoStack.shift()
      if (dropped) this.bytes -= dropped.bytes
    }
    this.onChange?.()
  }

  undo(): boolean {
    const cmd = this.undoStack.pop()
    if (!cmd) return false
    cmd.undo()
    this.redoStack.push(cmd)
    this.bytes -= cmd.bytes
    this.onChange?.()
    return true
  }

  redo(): boolean {
    const cmd = this.redoStack.pop()
    if (!cmd) return false
    cmd.redo()
    this.undoStack.push(cmd)
    this.bytes += cmd.bytes
    this.onChange?.()
    return true
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.bytes = 0
    this.onChange?.()
  }
}
