export type HorizontalWindow = {
  visibleText: string
  cursorInWindow: number
  scrollOffset: number
  hasLeftOverflow: boolean
  hasRightOverflow: boolean
}

/**
 * Compute horizontal scroll slice for single-line inputs that exceed viewport width.
 */
export function computeHorizontalWindow(
  text: string,
  cursor: number,
  viewportWidth: number,
  previousOffset = 0,
): HorizontalWindow {
  const width = Math.max(4, viewportWidth)
  const clampedCursor = Math.max(0, Math.min(cursor, text.length))
  let scrollOffset = Math.max(0, previousOffset)

  if (clampedCursor < scrollOffset) {
    scrollOffset = clampedCursor
  } else if (clampedCursor >= scrollOffset + width) {
    scrollOffset = clampedCursor - width + 1
  }

  const maxOffset = Math.max(0, text.length - width + 1)
  scrollOffset = Math.min(scrollOffset, maxOffset)

  return {
    visibleText: text.slice(scrollOffset, scrollOffset + width),
    cursorInWindow: clampedCursor - scrollOffset,
    scrollOffset,
    hasLeftOverflow: scrollOffset > 0,
    hasRightOverflow: scrollOffset + width < text.length,
  }
}
