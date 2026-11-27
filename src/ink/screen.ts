import {
  type AnsiCode,
  ansiCodesToString,
  diffAnsiCodes,
  reduceAnsiCodes,
  tokenize,
} from '@alcalzone/ansi-tokenize'
import { EMPTY_ANSI_CODES } from './constants.js'
import type { Rectangle } from './layout/geometry.js'
import { stringWidth } from './string_width.js'
import { SGR_INVERSE } from './termio/sgr.js'
import { sgrVisibleOnSpace } from './termio/sgr.js'

/**
 * 2-bit CellWidth encoding stored in bits [1:0] of packed word1:
 * - 0: Narrow (1-column glyph)
 * - 1: Wide (leading cell of a 2-column CJK/emoji glyph)
 * - 2: SpacerTail (trailing placeholder cell of a 2-column glyph)
 * - 3: SpacerHead (wrapped line-end spacer before a wide glyph on next line)
 */
export const CellWidth = {
  Narrow: 0,
  Wide: 1,
  SpacerTail: 2,
  SpacerHead: 3,
} as const
export type CellWidth = (typeof CellWidth)[keyof typeof CellWidth]

export type Hyperlink = string | undefined

export type Cell = {
  char: string
  styleId: number
  hyperlink: Hyperlink
  width: CellWidth
}

export const EMPTY_CHAR_ID = 0
export const EMPTY_STYLE_ID = 0
export const EMPTY_HYPERLINK_ID = 0

// word1 bit layout: [styleId: 15 bits (31..17)] [hyperlinkId: 15 bits (16..2)] [width: 2 bits (1..0)]
const STYLE_SHIFT = 17
const HYPERLINK_SHIFT = 2
const WIDTH_MASK = 0x3
const HYPERLINK_MASK = 0x7fff
const STYLE_MASK = 0x7fff

export function packWord1(
  styleId: number,
  hyperlinkId: number,
  width: CellWidth,
): number {
  return (
    ((styleId & STYLE_MASK) << STYLE_SHIFT) |
    ((hyperlinkId & HYPERLINK_MASK) << HYPERLINK_SHIFT) |
    (width & WIDTH_MASK)
  )
}

export function unpackStyleId(word1: number): number {
  return (word1 >>> STYLE_SHIFT) & STYLE_MASK
}

export function unpackHyperlinkId(word1: number): number {
  return (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
}

export function unpackWidth(word1: number): CellWidth {
  return (word1 & WIDTH_MASK) as CellWidth
}

// Empty cell packed 64-bit value: word0 = 0 (' '), word1 = 0 (style=0, link=0, width=Narrow)
const EMPTY_CELL_64 = 0n

/**
 * Intern pool mapping grapheme strings to compact 32-bit integer IDs.
 * ID 0 is always `' '` (space). Printable ASCII uses an O(1) Int32Array(128) fast path.
 */
export class CharPool {
  private readonly chars: string[] = [' ']
  private readonly map = new Map<string, number>([[' ', 0]])
  private readonly ascii = new Int32Array(128).fill(-1)

  constructor() {
    this.ascii[32] = 0
  }

  intern(char: string): number {
    if (char.length === 0 || char === ' ') return 0
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) {
        let id = this.ascii[code]!
        if (id !== -1) return id
        id = this.chars.length
        this.chars.push(char)
        this.ascii[code] = id
        this.map.set(char, id)
        return id
      }
    }
    let id = this.map.get(char)
    if (id !== undefined) return id
    id = this.chars.length
    this.chars.push(char)
    this.map.set(char, id)
    return id
  }

  get(id: number): string {
    return this.chars[id] ?? ' '
  }

  get size(): number {
    return this.chars.length
  }
}

/**
 * Intern pool for ANSI style chains.
 *
 * Bit 0 of every `styleId` encodes `VISIBLE_ON_SPACE`:
 * - Even IDs: invisible on space (e.g. plain fg color, bold, italic). ID 0 = empty style.
 * - Odd IDs: visible on space (bg color, inverse, underline, strikethrough).
 * This allows O(1) visibility checks via `(styleId & 1) !== 0`.
 *
 * Also caches `transition(fromId, toId)` escape strings to eliminate repeated
 * `diffAnsiCodes` allocations across frames.
 */
export class StylePool {
  private readonly styles: AnsiCode[][] = [EMPTY_ANSI_CODES, EMPTY_ANSI_CODES]
  private readonly keyToId = new Map<string, number>([['', 0]])
  private readonly transitionCache = new Map<number, string>()
  private readonly inverseCache = new Map<number, number>()
  private readonly selectionCache = new Map<string, number>()
  private nextEvenId = 2
  private nextOddId = 1

  intern(codes: AnsiCode[]): number {
    if (codes.length === 0) return EMPTY_STYLE_ID
    const reduced = reduceAnsiCodes(codes).filter(c => c.code !== c.endCode)
    if (reduced.length === 0) return EMPTY_STYLE_ID

    let key = ''
    let visibleOnSpace = false
    for (let i = 0; i < reduced.length; i++) {
      const code = reduced[i]!.code
      key += code
      if (!visibleOnSpace && sgrVisibleOnSpace(code)) {
        visibleOnSpace = true
      }
    }

    const existing = this.keyToId.get(key)
    if (existing !== undefined) return existing

    let id: number
    if (visibleOnSpace) {
      id = this.nextOddId
      this.nextOddId += 2
    } else {
      id = this.nextEvenId
      this.nextEvenId += 2
    }

    // Clamp safely within 15-bit style ID range (max 32767)
    if (id > STYLE_MASK) {
      return EMPTY_STYLE_ID
    }

    this.styles[id] = reduced
    this.keyToId.set(key, id)
    return id
  }

  get(id: number): AnsiCode[] {
    return this.styles[id] ?? EMPTY_ANSI_CODES
  }

  isVisibleOnSpace(id: number): boolean {
    return (id & 1) !== 0
  }

  transition(fromId: number, toId: number): string {
    if (fromId === toId) return ''
    const cacheKey = (fromId << 15) | toId
    const cached = this.transitionCache.get(cacheKey)
    if (cached !== undefined) return cached
    const diff = diffAnsiCodes(this.get(fromId), this.get(toId))
    const seq = diff.length > 0 ? ansiCodesToString(diff) : ''
    if (this.transitionCache.size < 16384) {
      this.transitionCache.set(cacheKey, seq)
    }
    return seq
  }

  withInverse(styleId: number): number {
    const cached = this.inverseCache.get(styleId)
    if (cached !== undefined) return cached
    const inverseCode: AnsiCode = {
      type: 'ansi',
      code: SGR_INVERSE,
      endCode: '\x1b[27m',
    }
    const nextId = this.intern([...this.get(styleId), inverseCode])
    this.inverseCache.set(styleId, nextId)
    return nextId
  }

  withCurrentMatch(styleId: number): number {
    return this.withSelectionBg(styleId, '\x1b[43m\x1b[30m')
  }

  withSelectionBg(styleId: number, bgSgr: string): number {
    const key = `${styleId}|${bgSgr}`
    const cached = this.selectionCache.get(key)
    if (cached !== undefined) return cached
    const tokens = tokenize(bgSgr).filter(
      (t): t is AnsiCode => t.type === 'ansi',
    )
    if (tokens.length === 0) return this.withInverse(styleId)
    const nextId = this.intern([...this.get(styleId), ...tokens])
    this.selectionCache.set(key, nextId)
    return nextId
  }

  get size(): number {
    return this.keyToId.size
  }
}

/**
 * Intern pool for OSC 8 hyperlink URLs. ID 0 represents no hyperlink.
 */
export class HyperlinkPool {
  private readonly links: (string | undefined)[] = [undefined]
  private readonly map = new Map<string, number>()

  intern(url: Hyperlink): number {
    if (!url) return EMPTY_HYPERLINK_ID
    const existing = this.map.get(url)
    if (existing !== undefined) return existing
    const id = this.links.length
    if (id > HYPERLINK_MASK) return EMPTY_HYPERLINK_ID
    this.links.push(url)
    this.map.set(url, id)
    return id
  }

  get(id: number): Hyperlink {
    return this.links[id]
  }

  get size(): number {
    return this.links.length
  }
}

/**
 * 8-byte/cell packed terminal screen buffer.
 *
 * Memory layout:
 * - Single `ArrayBuffer` of `width * height * 8` bytes viewed as:
 *   - `cells: Int32Array` (2 words per cell: word0 = charId, word1 = style|link|width)
 *   - `cells64: BigInt64Array` (1 BigInt per cell for O(1) cell equality & fast fill/copy)
 * - Parallel `noSelect: Uint8Array` (1 byte/cell: 1 = excluded from drag-selection copy)
 * - Parallel `softWrap: Int32Array` (1 bit/row: 1 = row is a soft-wrap continuation)
 */
export type Screen = {
  width: number
  height: number
  cells: Int32Array
  cells64: BigInt64Array
  noSelect: Uint8Array
  softWrap: Int32Array
  charPool: CharPool
  stylePool: StylePool
  hyperlinkPool: HyperlinkPool
  damage: Rectangle | undefined
}

export function createScreen(
  width: number,
  height: number,
  stylePool: StylePool = new StylePool(),
  charPool: CharPool = new CharPool(),
  hyperlinkPool: HyperlinkPool = new HyperlinkPool(),
): Screen {
  const w = Math.max(0, Math.floor(width))
  const h = Math.max(0, Math.floor(height))
  const size = w * h
  const buf = new ArrayBuffer(size << 3)
  return {
    width: w,
    height: h,
    cells: new Int32Array(buf),
    cells64: new BigInt64Array(buf),
    noSelect: new Uint8Array(size),
    softWrap: new Int32Array((h + 31) >>> 5),
    charPool,
    stylePool,
    hyperlinkPool,
    damage: undefined,
  }
}

export function resetScreen(
  screen: Screen,
  width: number,
  height: number,
): void {
  const w = Math.max(0, Math.floor(width))
  const h = Math.max(0, Math.floor(height))
  const size = w * h
  if (size > screen.cells64.length) {
    const buf = new ArrayBuffer(size << 3)
    screen.cells = new Int32Array(buf)
    screen.cells64 = new BigInt64Array(buf)
    screen.noSelect = new Uint8Array(size)
  } else {
    screen.cells64.fill(EMPTY_CELL_64, 0, size)
    screen.noSelect.fill(0, 0, size)
  }
  const swWords = (h + 31) >>> 5
  if (swWords > screen.softWrap.length) {
    screen.softWrap = new Int32Array(swWords)
  } else {
    screen.softWrap.fill(0, 0, swWords)
  }
  screen.width = w
  screen.height = h
  screen.damage = undefined
}

export function markDamage(screen: Screen, rect: Rectangle): void {
  if (rect.width <= 0 || rect.height <= 0) return
  if (!screen.damage) {
    screen.damage = { ...rect }
    return
  }
  const x1 = Math.min(screen.damage.x, rect.x)
  const y1 = Math.min(screen.damage.y, rect.y)
  const x2 = Math.max(
    screen.damage.x + screen.damage.width,
    rect.x + rect.width,
  )
  const y2 = Math.max(
    screen.damage.y + screen.damage.height,
    rect.y + rect.height,
  )
  screen.damage = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

export function setSoftWrap(screen: Screen, row: number, value: boolean): void {
  if (row < 0 || row >= screen.height) return
  const wordIdx = row >>> 5
  const mask = 1 << (row & 31)
  if (value) {
    screen.softWrap[wordIdx]! |= mask
  } else {
    screen.softWrap[wordIdx]! &= ~mask
  }
}

export function isSoftWrap(screen: Screen, row: number): boolean {
  if (row < 0 || row >= screen.height) return false
  return ((screen.softWrap[row >>> 5]! >>> (row & 31)) & 1) === 1
}

/**
 * Clean up orphaned halves when overwriting one cell of an existing wide glyph.
 */
function cleanWideOrphanAt(screen: Screen, x: number, y: number): void {
  const idx = y * screen.width + x
  const word1 = screen.cells[(idx << 1) + 1]!
  const existingWidth = unpackWidth(word1)
  if (existingWidth === CellWidth.Wide && x + 1 < screen.width) {
    screen.cells64[idx + 1] = EMPTY_CELL_64
  } else if (existingWidth === CellWidth.SpacerTail && x > 0) {
    screen.cells64[idx - 1] = EMPTY_CELL_64
  }
}

export function setCell(
  screen: Screen,
  x: number,
  y: number,
  char: string,
  styleId: number,
  hyperlink: Hyperlink,
  width: CellWidth = CellWidth.Narrow,
): void {
  if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) return
  cleanWideOrphanAt(screen, x, y)

  const charId = screen.charPool.intern(char)
  const linkId = screen.hyperlinkPool.intern(hyperlink)
  const idx = y * screen.width + x
  const wIdx = idx << 1
  screen.cells[wIdx] = charId
  screen.cells[wIdx + 1] = packWord1(styleId, linkId, width)

  if (width === CellWidth.Wide) {
    if (x + 1 < screen.width) {
      cleanWideOrphanAt(screen, x + 1, y)
      const tailWIdx = (idx + 1) << 1
      screen.cells[tailWIdx] = EMPTY_CHAR_ID
      screen.cells[tailWIdx + 1] = packWord1(styleId, linkId, CellWidth.SpacerTail)
      markDamage(screen, { x, y, width: 2, height: 1 })
      return
    }
    // Wide glyph does not fit in the last column -> write SpacerHead instead
    screen.cells[wIdx] = EMPTY_CHAR_ID
    screen.cells[wIdx + 1] = packWord1(styleId, linkId, CellWidth.SpacerHead)
  }

  markDamage(screen, { x, y, width: 1, height: 1 })
}

export function setCellStyleId(
  screen: Screen,
  x: number,
  y: number,
  styleId: number,
): void {
  if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) return
  const idx = y * screen.width + x
  const wIdx = (idx << 1) + 1
  const word1 = screen.cells[wIdx]!
  const linkId = unpackHyperlinkId(word1)
  const width = unpackWidth(word1)
  screen.cells[wIdx] = packWord1(styleId, linkId, width)
  markDamage(screen, { x, y, width: 1, height: 1 })
}

export function cellAt(screen: Screen, x: number, y: number): Cell | undefined {
  if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) {
    return undefined
  }
  return cellAtIndex(screen, y * screen.width + x)
}

export function cellAtIndex(screen: Screen, index: number): Cell {
  const wIdx = index << 1
  const charId = screen.cells[wIdx]!
  const word1 = screen.cells[wIdx + 1]!
  return {
    char: screen.charPool.get(charId),
    styleId: unpackStyleId(word1),
    hyperlink: screen.hyperlinkPool.get(unpackHyperlinkId(word1)),
    width: unpackWidth(word1),
  }
}

export function charInCellAt(screen: Screen, x: number, y: number): string {
  if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) return ' '
  const charId = screen.cells[(y * screen.width + x) << 1]!
  return screen.charPool.get(charId)
}

export function isEmptyCellAt(screen: Screen, x: number, y: number): boolean {
  if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) return true
  const idx = y * screen.width + x
  const wIdx = idx << 1
  const charId = screen.cells[wIdx]!
  if (charId !== EMPTY_CHAR_ID) return false
  const word1 = screen.cells[wIdx + 1]!
  const width = unpackWidth(word1)
  if (width === CellWidth.SpacerTail) return false
  const styleId = unpackStyleId(word1)
  if (screen.stylePool.isVisibleOnSpace(styleId)) return false
  return unpackHyperlinkId(word1) === EMPTY_HYPERLINK_ID
}

export function visibleCellAtIndex(screen: Screen, index: number): Cell | null {
  const wIdx = index << 1
  const word1 = screen.cells[wIdx + 1]!
  const width = unpackWidth(word1)
  if (width === CellWidth.SpacerTail) return null
  return {
    char: screen.charPool.get(screen.cells[wIdx]!),
    styleId: unpackStyleId(word1),
    hyperlink: screen.hyperlinkPool.get(unpackHyperlinkId(word1)),
    width,
  }
}

export function markNoSelectRect(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(screen.width, Math.floor(x + width))
  const y1 = Math.min(screen.height, Math.floor(y + height))
  for (let row = y0; row < y1; row++) {
    const base = row * screen.width
    screen.noSelect.fill(1, base + x0, base + x1)
  }
}

export function clearRegion(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(screen.width, Math.floor(x + width))
  const y1 = Math.min(screen.height, Math.floor(y + height))
  if (x1 <= x0 || y1 <= y0) return

  for (let row = y0; row < y1; row++) {
    cleanWideOrphanAt(screen, x0, row)
    if (x1 - 1 > x0) cleanWideOrphanAt(screen, x1 - 1, row)
    const base = row * screen.width
    screen.cells64.fill(EMPTY_CELL_64, base + x0, base + x1)
    screen.noSelect.fill(0, base + x0, base + x1)
  }
  markDamage(screen, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
}

/**
 * Copy a rectangular region from `src` into `dst` (double-buffer / ScrollBox blit).
 * Requires both screens to share the same `CharPool`, `StylePool`, and `HyperlinkPool`.
 */
export function blitRegion(
  src: Screen,
  dst: Screen,
  srcX: number,
  srcY: number,
  width: number,
  height: number,
  dstX = srcX,
  dstY = srcY,
): void {
  const w = Math.min(width, src.width - srcX, dst.width - dstX)
  const h = Math.min(height, src.height - srcY, dst.height - dstY)
  if (w <= 0 || h <= 0) return

  const samePools =
    src.charPool === dst.charPool &&
    src.stylePool === dst.stylePool &&
    src.hyperlinkPool === dst.hyperlinkPool

  for (let row = 0; row < h; row++) {
    const sy = srcY + row
    const dy = dstY + row
    if (sy < 0 || dy < 0 || sy >= src.height || dy >= dst.height) continue

    cleanWideOrphanAt(dst, dstX, dy)
    if (dstX + w - 1 > dstX) cleanWideOrphanAt(dst, dstX + w - 1, dy)

    const sOff = sy * src.width + srcX
    const dOff = dy * dst.width + dstX

    if (samePools) {
      dst.cells64.set(src.cells64.subarray(sOff, sOff + w), dOff)
      dst.noSelect.set(src.noSelect.subarray(sOff, sOff + w), dOff)
    } else {
      for (let col = 0; col < w; col++) {
        const cell = cellAtIndex(src, sOff + col)
        if (cell.width !== CellWidth.SpacerTail) {
          const mappedStyleId = dst.stylePool.intern(
            src.stylePool.get(cell.styleId),
          )
          setCell(dst, dstX + col, dy, cell.char, mappedStyleId, cell.hyperlink, cell.width)
        }
        dst.noSelect[dOff + col] = src.noSelect[sOff + col]!
      }
    }
    setSoftWrap(dst, dy, isSoftWrap(src, sy))
  }

  markDamage(dst, { x: dstX, y: dstY, width: w, height: h })
}

/**
 * Shift rows `[top..bottom]` (inclusive) vertically by `delta` rows in-place
 * (positive delta scrolls content UP, exposing blank rows at the bottom;
 * negative delta scrolls content DOWN, exposing blank rows at the top).
 */
export function shiftRows(
  screen: Screen,
  top: number,
  bottom: number,
  delta: number,
): void {
  if (delta === 0 || top < 0 || bottom >= screen.height || top > bottom) return
  const width = screen.width
  const regionHeight = bottom - top + 1
  if (Math.abs(delta) >= regionHeight) {
    clearRegion(screen, 0, top, width, regionHeight)
    return
  }

  if (delta > 0) {
    // Scroll UP: row y <- row y + delta
    for (let y = top; y <= bottom - delta; y++) {
      const dstOff = y * width
      const srcOff = (y + delta) * width
      screen.cells64.copyWithin(dstOff, srcOff, srcOff + width)
      screen.noSelect.copyWithin(dstOff, srcOff, srcOff + width)
      setSoftWrap(screen, y, isSoftWrap(screen, y + delta))
    }
    for (let y = bottom - delta + 1; y <= bottom; y++) {
      const off = y * width
      screen.cells64.fill(EMPTY_CELL_64, off, off + width)
      screen.noSelect.fill(0, off, off + width)
      setSoftWrap(screen, y, false)
    }
  } else {
    // Scroll DOWN: row y <- row y + delta (delta < 0)
    const shift = -delta
    for (let y = bottom; y >= top + shift; y--) {
      const dstOff = y * width
      const srcOff = (y - shift) * width
      screen.cells64.copyWithin(dstOff, srcOff, srcOff + width)
      screen.noSelect.copyWithin(dstOff, srcOff, srcOff + width)
      setSoftWrap(screen, y, isSoftWrap(screen, y - shift))
    }
    for (let y = top; y < top + shift; y++) {
      const off = y * width
      screen.cells64.fill(EMPTY_CELL_64, off, off + width)
      screen.noSelect.fill(0, off, off + width)
      setSoftWrap(screen, y, false)
    }
  }

  markDamage(screen, { x: 0, y: top, width, height: regionHeight })
}

/**
 * Iterate over every cell coordinate `(x, y)` where `prev` and `next` differ.
 * Uses 64-bit BigInt comparison when pools match for maximum throughput.
 * Returning `true` from `cb` terminates the diff early.
 */
export function diffEach(
  prev: Screen,
  next: Screen,
  cb: (x: number, y: number) => boolean | void,
): void {
  const maxH = Math.max(prev.height, next.height)
  const maxW = Math.max(prev.width, next.width)
  const sameWidth = prev.width === next.width
  const samePools =
    prev.charPool === next.charPool &&
    prev.stylePool === next.stylePool &&
    prev.hyperlinkPool === next.hyperlinkPool

  for (let y = 0; y < maxH; y++) {
    const inPrevRow = y < prev.height
    const inNextRow = y < next.height
    if (sameWidth && samePools && inPrevRow && inNextRow) {
      const rowOff = y * next.width
      const p64 = prev.cells64
      const n64 = next.cells64
      for (let x = 0; x < maxW; x++) {
        if (p64[rowOff + x] !== n64[rowOff + x]) {
          if (cb(x, y) === true) return
        }
      }
      continue
    }

    for (let x = 0; x < maxW; x++) {
      const pCell = inPrevRow && x < prev.width ? cellAt(prev, x, y) : undefined
      const nCell = inNextRow && x < next.width ? cellAt(next, x, y) : undefined
      const same =
        pCell !== undefined &&
        nCell !== undefined &&
        pCell.char === nCell.char &&
        pCell.styleId === nCell.styleId &&
        pCell.hyperlink === nCell.hyperlink &&
        pCell.width === nCell.width
      if (!same) {
        if (cb(x, y) === true) return
      }
    }
  }
}

/**
 * Write an ANSI-styled text string onto the screen starting at `(startX, startY)`
 * within an optional clipping rectangle. Handles OSC 8 hyperlinks, SGR styles,
 * and wide CJK/emoji characters cleanly.
 */
export function writeText(
  screen: Screen,
  startX: number,
  startY: number,
  text: string,
  clip?: Rectangle,
  options?: { noSelect?: boolean; baseStyleCodes?: AnsiCode[]; baseHyperlink?: Hyperlink },
): number {
  const minX = clip ? Math.max(0, clip.x) : 0
  const maxX = clip ? Math.min(screen.width, clip.x + clip.width) : screen.width
  const minY = clip ? Math.max(0, clip.y) : 0
  const maxY = clip ? Math.min(screen.height, clip.y + clip.height) : screen.height

  const lines = text.split('\n')
  const activeCodes: AnsiCode[] = options?.baseStyleCodes ? [...options.baseStyleCodes] : []
  let activeLink: Hyperlink = options?.baseHyperlink
  let currentStyleId = screen.stylePool.intern(activeCodes)

  for (let li = 0; li < lines.length; li++) {
    const y = startY + li
    if (y >= maxY) break
    const line = lines[li]!
    const tokens = tokenize(line)
    let x = startX

    for (const token of tokens) {
      if (token.type === 'ansi') {
        // Detect OSC 8 hyperlink open/close
        if (token.code.startsWith('\x1b]8;')) {
          const stripped = token.code.endsWith('\x1b\\')
            ? token.code.slice(4, -2)
            : token.code.endsWith('\x07')
              ? token.code.slice(4, -1)
              : token.code.slice(4)
          const semi = stripped.indexOf(';')
          const url = semi === -1 ? '' : stripped.slice(semi + 1)
          activeLink = url.length > 0 ? url : undefined
        } else {
          activeCodes.push(token)
          currentStyleId = screen.stylePool.intern(activeCodes)
        }
        continue
      }

      if (token.type !== 'char') continue

      const w = token.fullWidth ? 2 : stringWidth(token.value)
      if (w === 0) continue

      if (y >= minY && y < maxY) {
        if (w === 2) {
          if (x >= minX && x + 1 < maxX) {
            setCell(screen, x, y, token.value, currentStyleId, activeLink, CellWidth.Wide)
            if (options?.noSelect) {
              const idx = y * screen.width + x
              screen.noSelect[idx] = 1
              screen.noSelect[idx + 1] = 1
            }
          }
        } else if (x >= minX && x < maxX) {
          setCell(screen, x, y, token.value, currentStyleId, activeLink, CellWidth.Narrow)
          if (options?.noSelect) {
            screen.noSelect[y * screen.width + x] = 1
          }
        }
      }
      x += w
    }
  }

  return lines.length
}

/**
 * Render the plain text lines of a screen (stripping styles), useful for
 * snapshots, search indexing, and unit tests.
 */
export function screenToPlainLines(screen: Screen): string[] {
  const lines: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)!
      if (cell.width === CellWidth.SpacerTail) continue
      line += cell.char
    }
    lines.push(line.trimEnd())
  }
  return lines
}
