import { ansiCodesToString, diffAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'
import type { Diff, FlickerReason, Frame, Patch } from './frame.js'
import {
  CellWidth,
  cellAt,
  diffEach,
  type Hyperlink,
  isEmptyCellAt,
  type Screen,
  shiftRows,
  type StylePool,
} from './screen.js'
import {
  CURSOR_HOME,
  RESET_SCROLL_REGION,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  setScrollRegion,
} from './termio/csi.js'
import { LINK_END, link as oscLink } from './termio/osc.js'

export type LogUpdateOptions = {
  isTTY: boolean
  stylePool: StylePool
}

/**
 * Tracks virtual cursor position during relative main-screen updates.
 */
class VirtualScreen {
  x: number
  y: number
  readonly ops: Patch[] = []

  constructor(startX: number, startY: number) {
    this.x = startX
    this.y = startY
  }

  moveTo(targetX: number, targetY: number): void {
    const dx = targetX - this.x
    const dy = targetY - this.y
    if (dx === 0 && dy === 0) return
    if (targetX === 0 && dy === 0) {
      this.ops.push({ type: 'carriageReturn' })
    } else {
      this.ops.push({ type: 'cursorMove', x: dx, y: dy })
    }
    this.x = targetX
    this.y = targetY
  }

  push(patch: Patch, dx = 0, dy = 0): void {
    this.ops.push(patch)
    this.x += dx
    this.y += dy
  }
}

function renderRowToString(
  screen: Screen,
  y: number,
  stylePool: StylePool,
): string {
  let line = ''
  let currentStyleId = 0
  let currentLink: Hyperlink = undefined

  // Find last non-empty column so we avoid trailing blank padding
  let lastNonEmpty = -1
  for (let x = screen.width - 1; x >= 0; x--) {
    if (!isEmptyCellAt(screen, x, y)) {
      lastNonEmpty = x
      break
    }
  }

  for (let x = 0; x <= lastNonEmpty; x++) {
    const cell = cellAt(screen, x, y)
    if (!cell || cell.width === CellWidth.SpacerTail) continue

    if (cell.hyperlink !== currentLink) {
      if (currentLink !== undefined) line += LINK_END
      if (cell.hyperlink !== undefined) line += oscLink(cell.hyperlink)
      currentLink = cell.hyperlink
    }
    if (cell.styleId !== currentStyleId) {
      line += stylePool.transition(currentStyleId, cell.styleId)
      currentStyleId = cell.styleId
    }
    line += cell.char
  }

  if (currentLink !== undefined) {
    line += LINK_END
  }
  if (currentStyleId !== 0) {
    line += stylePool.transition(currentStyleId, 0)
  }

  return line
}

function fullResetPatches(
  next: Frame,
  reason: FlickerReason,
  stylePool: StylePool,
  altScreen: boolean,
): Diff {
  const ops: Patch[] = [{ type: 'cursorHide' }, { type: 'clearTerminal', reason }]
  const { screen } = next

  if (altScreen) {
    for (let y = 0; y < screen.height; y++) {
      const line = renderRowToString(screen, y, stylePool)
      if (line.length > 0) {
        ops.push({ type: 'cursorTo', x: 0, y })
        ops.push({ type: 'stdout', content: line })
      }
    }
  } else {
    const lines: string[] = []
    for (let y = 0; y < screen.height; y++) {
      lines.push(renderRowToString(screen, y, stylePool))
    }
    if (lines.length > 0) {
      ops.push({ type: 'stdout', content: lines.join('\n') })
    }
  }

  if (next.cursor.visible) {
    if (altScreen) {
      ops.push({ type: 'cursorTo', x: next.cursor.x, y: next.cursor.y })
    }
    ops.push({ type: 'cursorShow' })
  }

  return ops
}

/**
 * Double-buffered screen diff generator supporting:
 * - Main-screen mode (`VirtualScreen` relative cursor updates)
 * - Alt-Screen (`DEC 1049`) absolute cell diffs + DECSTBM hardware scroll hints
 * - Non-TTY plain full-frame rendering
 */
export class LogUpdate {
  private hasRendered = false

  constructor(private readonly options: LogUpdateOptions) {}

  reset(): void {
    this.hasRendered = false
  }

  renderFullFrame(frame: Frame): Diff {
    const { screen } = frame
    const lines: string[] = []
    let currentStyles: AnsiCode[] = []
    let currentHyperlink: Hyperlink = undefined

    for (let y = 0; y < screen.height; y++) {
      let line = ''
      for (let x = 0; x < screen.width; x++) {
        const cell = cellAt(screen, x, y)
        if (!cell || cell.width === CellWidth.SpacerTail) continue

        if (cell.hyperlink !== currentHyperlink) {
          if (currentHyperlink !== undefined) line += LINK_END
          if (cell.hyperlink !== undefined) line += oscLink(cell.hyperlink)
          currentHyperlink = cell.hyperlink
        }
        const cellStyles = this.options.stylePool.get(cell.styleId)
        const styleDiff = diffAnsiCodes(currentStyles, cellStyles)
        if (styleDiff.length > 0) {
          line += ansiCodesToString(styleDiff)
          currentStyles = cellStyles
        }
        line += cell.char
      }
      if (currentHyperlink !== undefined) {
        line += LINK_END
        currentHyperlink = undefined
      }
      const resetCodes = diffAnsiCodes(currentStyles, [])
      if (resetCodes.length > 0) {
        line += ansiCodesToString(resetCodes)
        currentStyles = []
      }
      lines.push(line.trimEnd())
    }

    if (lines.length === 0) return []
    return [{ type: 'stdout', content: lines.join('\n') }]
  }

  render(
    prev: Frame,
    next: Frame,
    altScreen = false,
    decstbmSafe = true,
  ): Diff {
    if (!this.options.isTTY) {
      return this.renderFullFrame(next)
    }

    const stylePool = this.options.stylePool

    // Viewport shrunk or width changed -> full reset
    if (
      this.hasRendered &&
      (next.viewport.height < prev.viewport.height ||
        (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width))
    ) {
      return fullResetPatches(next, 'resize', stylePool, altScreen)
    }

    this.hasRendered = true

    if (altScreen) {
      return this.renderAltScreen(prev, next, decstbmSafe)
    }

    return this.renderMainScreen(prev, next)
  }

  private renderAltScreen(
    prev: Frame,
    next: Frame,
    decstbmSafe: boolean,
  ): Diff {
    const stylePool = this.options.stylePool
    const ops: Patch[] = [{ type: 'cursorHide' }]

    // Hardware DECSTBM scroll optimization when synchronized output makes it atomic
    if (next.scrollHint && decstbmSafe) {
      const { top, bottom, delta } = next.scrollHint
      if (
        delta !== 0 &&
        top >= 0 &&
        bottom < prev.screen.height &&
        bottom < next.screen.height &&
        bottom > top
      ) {
        shiftRows(prev.screen, top, bottom, delta)
        ops.push({
          type: 'stdout',
          content:
            setScrollRegion(top + 1, bottom + 1) +
            (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
            RESET_SCROLL_REGION +
            CURSOR_HOME,
        })
      }
    }

    // Collect rows containing any changed cells
    const dirtyRows = new Set<number>()
    diffEach(prev.screen, next.screen, (_x, y) => {
      if (y < next.screen.height) {
        dirtyRows.add(y)
      }
    })

    for (const y of [...dirtyRows].sort((a, b) => a - b)) {
      ops.push({ type: 'cursorTo', x: 0, y })
      ops.push({ type: 'clearLine' })
      const line = renderRowToString(next.screen, y, stylePool)
      if (line.length > 0) {
        ops.push({ type: 'stdout', content: line })
      }
    }

    if (next.cursor.visible) {
      ops.push({ type: 'cursorTo', x: next.cursor.x, y: next.cursor.y })
      ops.push({ type: 'cursorShow' })
    }

    return ops
  }

  private renderMainScreen(prev: Frame, next: Frame): Diff {
    const stylePool = this.options.stylePool

    // If shrinking from larger than viewport to fitting viewport, full reset
    if (
      prev.screen.height > prev.viewport.height &&
      next.screen.height <= next.viewport.height
    ) {
      return fullResetPatches(next, 'offscreen', stylePool, false)
    }

    const vs = new VirtualScreen(prev.cursor.x, prev.cursor.y)
    vs.push({ type: 'cursorHide' })

    // If screen shrank, clear excess bottom lines
    if (next.screen.height < prev.screen.height) {
      const linesToClear = prev.screen.height - next.screen.height
      if (linesToClear > prev.viewport.height) {
        return fullResetPatches(next, 'offscreen', stylePool, false)
      }
      vs.moveTo(0, prev.screen.height - 1)
      vs.push({ type: 'clear', count: linesToClear }, 0, -(linesToClear - 1))
      vs.y = next.screen.height
    }

    // Determine dirty rows
    const dirtyRows = new Set<number>()
    diffEach(prev.screen, next.screen, (_x, y) => {
      if (y < next.screen.height) {
        dirtyRows.add(y)
      }
    })

    const sortedRows = [...dirtyRows].sort((a, b) => a - b)

    // Ensure screen grows vertically if next.screen.height > prev.screen.height
    if (next.screen.height > prev.screen.height) {
      const extra = next.screen.height - prev.screen.height
      if (prev.screen.height > 0) {
        vs.moveTo(0, prev.screen.height)
      }
      vs.push({ type: 'stdout', content: '\n'.repeat(extra) }, 0, extra)
    }

    for (const y of sortedRows) {
      vs.moveTo(0, y)
      vs.push({ type: 'clearLine' })
      const line = renderRowToString(next.screen, y, stylePool)
      if (line.length > 0) {
        vs.push({ type: 'stdout', content: line })
      }
    }

    // Park cursor at bottom of rendered area or declared position
    const endX = next.cursor.visible ? next.cursor.x : 0
    const endY = next.cursor.visible ? next.cursor.y : next.screen.height
    vs.moveTo(endX, endY)

    if (next.cursor.visible) {
      vs.push({ type: 'cursorShow' })
    }

    return vs.ops
  }

  getDoneOps(prev: Frame): Diff {
    this.hasRendered = false
    if (!prev.cursor.visible) {
      return [{ type: 'cursorShow' }]
    }
    return []
  }
}
