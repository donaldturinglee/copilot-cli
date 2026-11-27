import { clamp } from './layout/geometry.js'
import {
  CellWidth,
  cellAt,
  isSoftWrap,
  type Screen,
  setCellStyleId,
  type StylePool,
} from './screen.js'

export type SelectionPoint = {
  col: number
  row: number
}

export type SelectionBounds = {
  start: SelectionPoint
  end: SelectionPoint
}

export type SelectionState = {
  anchor: SelectionPoint | null
  focus: SelectionPoint | null
  isDragging: boolean
  anchorSpan: {
    lo: SelectionPoint
    hi: SelectionPoint
    kind: 'word' | 'line'
  } | null
  scrolledOffAbove: string[]
  scrolledOffBelow: string[]
  scrolledOffAboveSW: boolean[]
  scrolledOffBelowSW: boolean[]
  virtualAnchorRow?: number
  virtualFocusRow?: number
  lastPressHadAlt: boolean
}

export function createSelectionState(): SelectionState {
  return {
    anchor: null,
    focus: null,
    isDragging: false,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],
    scrolledOffAboveSW: [],
    scrolledOffBelowSW: [],
    lastPressHadAlt: false,
  }
}

export function startSelection(
  s: SelectionState,
  col: number,
  row: number,
  hadAlt = false,
): void {
  s.anchor = { col, row }
  s.focus = null
  s.isDragging = true
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = hadAlt
}

export function updateSelection(
  s: SelectionState,
  col: number,
  row: number,
): void {
  if (!s.isDragging) return
  if (!s.focus && s.anchor && s.anchor.col === col && s.anchor.row === row) {
    return
  }
  s.focus = { col, row }
}

export function finishSelection(s: SelectionState): void {
  s.isDragging = false
}

export function clearSelection(s: SelectionState): void {
  s.anchor = null
  s.focus = null
  s.isDragging = false
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null
}

function comparePoints(a: SelectionPoint, b: SelectionPoint): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  return 0
}

export function selectionBounds(s: SelectionState): SelectionBounds | null {
  if (!s.anchor || !s.focus) return null
  return comparePoints(s.anchor, s.focus) <= 0
    ? { start: s.anchor, end: s.focus }
    : { start: s.focus, end: s.anchor }
}

const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

function charClass(c: string): 0 | 1 | 2 {
  if (c === ' ' || c === '') return 0
  if (WORD_CHAR.test(c)) return 1
  return 2
}

export function selectWordAt(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  if (row < 0 || row >= screen.height) return
  const width = screen.width
  const rowOff = row * width
  let c = clamp(col, 0, Math.max(0, width - 1))
  if (c > 0 && cellAt(screen, c, row)?.width === CellWidth.SpacerTail) c--
  if (screen.noSelect[rowOff + c] === 1) return

  const startCell = cellAt(screen, c, row)
  if (!startCell) return
  const cls = charClass(startCell.char)

  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (screen.noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc) break
    if (pc.width === CellWidth.SpacerTail) {
      if (prev === 0 || screen.noSelect[rowOff + prev - 1] === 1) break
      const head = cellAt(screen, prev - 1, row)
      if (!head || charClass(head.char) !== cls) break
      lo = prev - 1
      continue
    }
    if (charClass(pc.char) !== cls) break
    lo = prev
  }

  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (screen.noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc) break
    if (nc.width === CellWidth.SpacerTail) {
      hi = next
      continue
    }
    if (charClass(nc.char) !== cls) break
    hi = next
  }

  const loPt = { col: lo, row }
  const hiPt = { col: hi, row }
  s.anchor = loPt
  s.focus = hiPt
  s.isDragging = true
  s.anchorSpan = { lo: loPt, hi: hiPt, kind: 'word' }
}

export function selectLineAt(
  s: SelectionState,
  screen: Screen,
  row: number,
): void {
  if (row < 0 || row >= screen.height) return
  const lo = { col: 0, row }
  const hi = { col: Math.max(0, screen.width - 1), row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = false
  s.anchorSpan = { lo, hi, kind: 'line' }
}

/**
 * Paint selection highlight background onto selected non-noSelect cells in `screen`.
 */
export function applySelectionOverlay(
  screen: Screen,
  s: SelectionState,
  stylePool: StylePool,
  selectionBgSgr = '\x1b[48;2;38;79;120m',
): void {
  const bounds = selectionBounds(s)
  if (!bounds) return

  const startRow = clamp(bounds.start.row, 0, Math.max(0, screen.height - 1))
  const endRow = clamp(bounds.end.row, 0, Math.max(0, screen.height - 1))

  for (let row = startRow; row <= endRow; row++) {
    const colStart = row === bounds.start.row ? clamp(bounds.start.col, 0, screen.width - 1) : 0
    const colEnd =
      row === bounds.end.row
        ? clamp(bounds.end.col, 0, screen.width - 1)
        : screen.width - 1
    const rowOff = row * screen.width

    for (let col = colStart; col <= colEnd; col++) {
      if (screen.noSelect[rowOff + col] === 1) continue
      const cell = cellAt(screen, col, row)
      if (!cell || cell.width === CellWidth.SpacerTail) continue
      const highlighted = stylePool.withSelectionBg(cell.styleId, selectionBgSgr)
      setCellStyleId(screen, col, row, highlighted)
      if (cell.width === CellWidth.Wide && col + 1 < screen.width) {
        setCellStyleId(screen, col + 1, row, highlighted)
      }
    }
  }
}

/**
 * Extract selected text from the packed screen buffer, skipping `<NoSelect>`
 * gutters/chrome and joining `softWrap` continuation lines seamlessly.
 */
export function getSelectedText(s: SelectionState, screen: Screen): string {
  const bounds = selectionBounds(s)
  if (!bounds || screen.height === 0 || screen.width === 0) return ''

  const rows: { text: string; softWrapped: boolean }[] = []

  for (let i = 0; i < s.scrolledOffAbove.length; i++) {
    rows.push({
      text: s.scrolledOffAbove[i]!,
      softWrapped: s.scrolledOffAboveSW[i] ?? false,
    })
  }

  const startRow = clamp(bounds.start.row, 0, screen.height - 1)
  const endRow = clamp(bounds.end.row, 0, screen.height - 1)

  for (let row = startRow; row <= endRow; row++) {
    const colStart =
      row === bounds.start.row ? clamp(bounds.start.col, 0, screen.width - 1) : 0
    const colEnd =
      row === bounds.end.row
        ? clamp(bounds.end.col, 0, screen.width - 1)
        : screen.width - 1
    const rowOff = row * screen.width

    let line = ''
    for (let col = colStart; col <= colEnd; col++) {
      if (screen.noSelect[rowOff + col] === 1) continue
      const cell = cellAt(screen, col, row)
      if (!cell || cell.width === CellWidth.SpacerTail) continue
      line += cell.char
    }
    rows.push({
      text: line.trimEnd(),
      softWrapped: isSoftWrap(screen, row),
    })
  }

  for (let i = 0; i < s.scrolledOffBelow.length; i++) {
    rows.push({
      text: s.scrolledOffBelow[i]!,
      softWrapped: s.scrolledOffBelowSW[i] ?? false,
    })
  }

  if (rows.length === 0) return ''

  let out = rows[0]!.text
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i]!
    if (cur.softWrapped) {
      out += cur.text
    } else {
      out += '\n' + cur.text
    }
  }
  return out
}
