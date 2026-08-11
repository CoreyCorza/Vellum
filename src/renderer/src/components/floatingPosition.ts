export type FloatingPoint = { x: number; y: number }

export type FloatingAnchor = {
  horizontal: 'left' | 'right'
  vertical: 'top' | 'bottom'
  offsetX: number
  offsetY: number
}

export type FloatingSize = { width: number; height: number }

const MARGIN = 4
const STORAGE_PREFIX = 'vellum.floating-layout.'
const SIZE_STORAGE_PREFIX = 'vellum.floating-size.'

const isFloatingAnchor = (value: unknown): value is FloatingAnchor => {
  if (!value || typeof value !== 'object') return false
  const anchor = value as Partial<FloatingAnchor>
  return (
    (anchor.horizontal === 'left' || anchor.horizontal === 'right') &&
    (anchor.vertical === 'top' || anchor.vertical === 'bottom') &&
    typeof anchor.offsetX === 'number' &&
    Number.isFinite(anchor.offsetX) &&
    anchor.offsetX >= 0 &&
    typeof anchor.offsetY === 'number' &&
    Number.isFinite(anchor.offsetY) &&
    anchor.offsetY >= 0
  )
}

export const loadFloatingAnchor = (
  id: string,
  fallback: FloatingAnchor
): FloatingAnchor => {
  try {
    const saved = localStorage.getItem(`${STORAGE_PREFIX}${id}`)
    if (!saved) return fallback
    const parsed: unknown = JSON.parse(saved)
    return isFloatingAnchor(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export const saveFloatingAnchor = (id: string, anchor: FloatingAnchor): void => {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(anchor))
  } catch {
    // A blocked/full storage area should never prevent the UI from moving.
  }
}

const isFloatingSize = (value: unknown): value is FloatingSize => {
  if (!value || typeof value !== 'object') return false
  const size = value as Partial<FloatingSize>
  return (
    typeof size.width === 'number' &&
    Number.isFinite(size.width) &&
    size.width > 0 &&
    typeof size.height === 'number' &&
    Number.isFinite(size.height) &&
    size.height > 0
  )
}

export const loadFloatingSize = (id: string): FloatingSize | null => {
  try {
    const saved = localStorage.getItem(`${SIZE_STORAGE_PREFIX}${id}`)
    if (!saved) return null
    const parsed: unknown = JSON.parse(saved)
    return isFloatingSize(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const saveFloatingSize = (id: string, size: FloatingSize): void => {
  try {
    localStorage.setItem(`${SIZE_STORAGE_PREFIX}${id}`, JSON.stringify(size))
  } catch {
    // Resizing remains usable even when persistence is unavailable.
  }
}

const getBounds = (
  element: HTMLElement
): { root: HTMLElement; maxX: number; maxY: number } | null => {
  const root = element.parentElement
  if (!root) return null

  const statusHeight = root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0
  return {
    root,
    maxX: Math.max(MARGIN, root.clientWidth - element.offsetWidth - MARGIN),
    maxY: Math.max(
      MARGIN,
      root.clientHeight - statusHeight - element.offsetHeight - MARGIN
    )
  }
}

export const constrainFloatingPosition = (
  element: HTMLElement,
  position: FloatingPoint
): FloatingPoint => {
  const bounds = getBounds(element)
  if (!bounds) return position
  return {
    x: Math.max(MARGIN, Math.min(bounds.maxX, position.x)),
    y: Math.max(MARGIN, Math.min(bounds.maxY, position.y))
  }
}

export const anchorForFloatingPosition = (
  element: HTMLElement,
  position: FloatingPoint
): FloatingAnchor => {
  const bounds = getBounds(element)
  if (!bounds) {
    return { horizontal: 'left', vertical: 'top', offsetX: position.x, offsetY: position.y }
  }

  const right = bounds.root.clientWidth - element.offsetWidth - position.x
  const bottom =
    bounds.root.clientHeight -
    (bounds.root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0) -
    element.offsetHeight -
    position.y

  return {
    horizontal: position.x <= right ? 'left' : 'right',
    vertical: position.y <= bottom ? 'top' : 'bottom',
    offsetX: position.x <= right ? position.x : right,
    offsetY: position.y <= bottom ? position.y : bottom
  }
}

export const positionForFloatingAnchor = (
  element: HTMLElement,
  anchor: FloatingAnchor
): FloatingPoint => {
  const root = element.parentElement
  if (!root) return { x: anchor.offsetX, y: anchor.offsetY }

  const statusHeight = root.querySelector<HTMLElement>('#status')?.offsetHeight ?? 0
  return constrainFloatingPosition(element, {
    x:
      anchor.horizontal === 'left'
        ? anchor.offsetX
        : root.clientWidth - element.offsetWidth - anchor.offsetX,
    y:
      anchor.vertical === 'top'
        ? anchor.offsetY
        : root.clientHeight - statusHeight - element.offsetHeight - anchor.offsetY
  })
}
