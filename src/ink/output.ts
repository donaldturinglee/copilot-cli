import { type AnsiCode, tokenize } from '@alcalzone/ansi-tokenize'
import { intersectRect, type Rectangle } from './layout/geometry.js'
import {
  CellWidth,
  markNoSelectRect,
  type Screen,
  setCell,
  setSoftWrap,
  writeText,
} from './screen.js'

export type WriteOptions = {
  clip?: Rectangle
  noSelect?: boolean
  softWrapFlags?: boolean[]
}

/**
 * High-level drawing surface backed by a packed 8-byte/cell `Screen`.
 * Maintains a clip stack and forwards styled text, background fills,
 * soft-wrap metadata, and `<NoSelect>` masks directly into the cell buffer.
 */
export class Output {
  private readonly clipStack: Rectangle[] = []

  constructor(readonly screen: Screen) {}

  get width(): number {
    return this.screen.width
  }

  get height(): number {
    return this.screen.height
  }

  pushClip(rect: Rectangle): void {
    const current = this.currentClip()
    const next = current ? intersectRect(current, rect) : rect
    this.clipStack.push(next ?? { x: 0, y: 0, width: 0, height: 0 })
  }

  popClip(): void {
    this.clipStack.pop()
  }

  currentClip(): Rectangle | undefined {
    return this.clipStack[this.clipStack.length - 1]
  }

  fillBackground(
    x: number,
    y: number,
    width: number,
    height: number,
    bgSgr: string,
    clip?: Rectangle,
    noSelect?: boolean,
  ): void {
    const effectiveClip = this.mergeClip(clip)
    const tokens = tokenize(bgSgr).filter(
      (t): t is AnsiCode => t.type === 'ansi',
    )
    if (tokens.length === 0) return
    const styleId = this.screen.stylePool.intern(tokens)

    const minX = effectiveClip ? Math.max(0, effectiveClip.x) : 0
    const maxX = effectiveClip
      ? Math.min(this.screen.width, effectiveClip.x + effectiveClip.width)
      : this.screen.width
    const minY = effectiveClip ? Math.max(0, effectiveClip.y) : 0
    const maxY = effectiveClip
      ? Math.min(this.screen.height, effectiveClip.y + effectiveClip.height)
      : this.screen.height

    const x0 = Math.max(minX, Math.floor(x))
    const x1 = Math.min(maxX, Math.floor(x + width))
    const y0 = Math.max(minY, Math.floor(y))
    const y1 = Math.min(maxY, Math.floor(y + height))

    for (let row = y0; row < y1; row++) {
      for (let col = x0; col < x1; col++) {
        setCell(this.screen, col, row, ' ', styleId, undefined, CellWidth.Narrow)
        if (noSelect) {
          this.screen.noSelect[row * this.screen.width + col] = 1
        }
      }
    }
  }

  write(
    x: number,
    y: number,
    text: string,
    options: WriteOptions = {},
  ): void {
    const effectiveClip = this.mergeClip(options.clip)
    if (effectiveClip && (effectiveClip.width <= 0 || effectiveClip.height <= 0)) {
      return
    }
    const lineCount = writeText(
      this.screen,
      Math.floor(x),
      Math.floor(y),
      text,
      effectiveClip,
      { noSelect: options.noSelect },
    )
    if (options.softWrapFlags) {
      for (let i = 0; i < lineCount && i < options.softWrapFlags.length; i++) {
        const row = Math.floor(y) + i
        if (
          !effectiveClip ||
          (row >= effectiveClip.y && row < effectiveClip.y + effectiveClip.height)
        ) {
          setSoftWrap(this.screen, row, options.softWrapFlags[i]!)
        }
      }
    }
  }

  markNoSelect(
    x: number,
    y: number,
    width: number,
    height: number,
    fromLeftEdge = false,
  ): void {
    const startX = fromLeftEdge ? 0 : x
    const spanW = fromLeftEdge ? x + width : width
    markNoSelectRect(this.screen, startX, y, spanW, height)
  }

  private mergeClip(clip?: Rectangle): Rectangle | undefined {
    const cur = this.currentClip()
    if (!cur) return clip
    if (!clip) return cur
    return intersectRect(cur, clip) ?? { x: 0, y: 0, width: 0, height: 0 }
  }
}
