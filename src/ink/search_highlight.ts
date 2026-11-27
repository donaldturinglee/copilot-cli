import {
  CellWidth,
  cellAt,
  type Screen,
  setCellStyleId,
  type StylePool,
} from './screen.js'

export type ScreenSearchMatch = {
  row: number
  startCol: number
  endCol: number
}

export type SearchHighlightState = {
  query: string
  matches: ScreenSearchMatch[]
  activeIndex: number
}

export function findScreenMatches(
  screen: Screen,
  query: string,
  caseSensitive = false,
): ScreenSearchMatch[] {
  if (!query || screen.width === 0 || screen.height === 0) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: ScreenSearchMatch[] = []

  for (let row = 0; row < screen.height; row++) {
    const colMap: number[] = []
    let line = ''
    for (let col = 0; col < screen.width; col++) {
      const cell = cellAt(screen, col, row)
      if (!cell || cell.width === CellWidth.SpacerTail) continue
      colMap.push(col)
      line += cell.char
    }
    const hay = caseSensitive ? line : line.toLowerCase()
    let idx = hay.indexOf(needle)
    while (idx !== -1) {
      const startCol = colMap[idx] ?? idx
      const endIdx = Math.min(colMap.length - 1, idx + needle.length - 1)
      const endCol = colMap[endIdx] ?? startCol
      matches.push({ row, startCol, endCol })
      idx = hay.indexOf(needle, idx + needle.length)
    }
  }

  return matches
}

export function applySearchHighlights(
  screen: Screen,
  state: SearchHighlightState,
  stylePool: StylePool,
): void {
  for (let i = 0; i < state.matches.length; i++) {
    const match = state.matches[i]!
    const isActive = i === state.activeIndex
    for (let col = match.startCol; col <= match.endCol; col++) {
      const cell = cellAt(screen, col, match.row)
      if (!cell || cell.width === CellWidth.SpacerTail) continue
      const nextStyle = isActive
        ? stylePool.withCurrentMatch(cell.styleId)
        : stylePool.withInverse(cell.styleId)
      setCellStyleId(screen, col, match.row, nextStyle)
    }
  }
}
