import { getGraphemeSegmenter } from '../utilities/intl.js'

export type CursorPosition = {
  line: number
  column: number
}

function segmentGraphemes(text: string): { segment: string; index: number }[] {
  const out: { segment: string; index: number }[] = []
  for (const item of getGraphemeSegmenter().segment(text)) {
    out.push({ segment: item.segment, index: item.index })
  }
  return out
}

function clampOffset(text: string, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= text.length) return text.length
  // Snap to valid grapheme boundary
  const segs = segmentGraphemes(text)
  let best = 0
  for (const s of segs) {
    if (s.index <= offset) best = s.index
    else break
  }
  return best
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

/**
 * Immutable grapheme-aware multi-line text cursor supporting UTF-16 surrogate
 * pairs, combining marks, emoji ZWJ sequences, word navigation, and readline edits.
 */
export class Cursor {
  readonly text: string
  readonly offset: number
  readonly columns: number

  constructor(text: string, offset = text.length, columns = 80) {
    this.text = text
    this.columns = Math.max(1, columns)
    this.offset = clampOffset(text, offset)
  }

  static fromText(text: string, columns = 80, offset = text.length): Cursor {
    return new Cursor(text, offset, columns)
  }

  isAtStart(): boolean {
    return this.offset === 0
  }

  isAtEnd(): boolean {
    return this.offset === this.text.length
  }

  equals(other: Cursor): boolean {
    return this.text === other.text && this.offset === other.offset
  }

  left(): Cursor {
    if (this.offset === 0) return this
    const segs = segmentGraphemes(this.text)
    let prev = 0
    for (const s of segs) {
      if (s.index >= this.offset) break
      prev = s.index
    }
    return new Cursor(this.text, prev, this.columns)
  }

  right(): Cursor {
    if (this.offset >= this.text.length) return this
    const segs = segmentGraphemes(this.text)
    for (const s of segs) {
      if (s.index > this.offset) {
        return new Cursor(this.text, s.index, this.columns)
      }
    }
    return new Cursor(this.text, this.text.length, this.columns)
  }

  getPosition(): CursorPosition {
    const before = this.text.slice(0, this.offset)
    const lines = before.split('\n')
    const line = lines.length - 1
    const lastLine = lines[line] ?? ''
    const column = segmentGraphemes(lastLine).length
    return { line, column }
  }

  startOfLine(): Cursor {
    const prevNl = this.text.lastIndexOf('\n', Math.max(0, this.offset - 1))
    const nextOff = this.offset === 0 ? 0 : prevNl === -1 ? 0 : prevNl + 1
    return new Cursor(this.text, nextOff, this.columns)
  }

  endOfLine(): Cursor {
    const nextNl = this.text.indexOf('\n', this.offset)
    const nextOff = nextNl === -1 ? this.text.length : nextNl
    return new Cursor(this.text, nextOff, this.columns)
  }

  up(): Cursor {
    const { line, column } = this.getPosition()
    if (line === 0) return this
    const lines = this.text.split('\n')
    let offset = 0
    for (let i = 0; i < line - 1; i++) {
      offset += lines[i]!.length + 1
    }
    const targetSegs = segmentGraphemes(lines[line - 1]!)
    const targetCol = Math.min(column, targetSegs.length)
    const colOffset =
      targetCol < targetSegs.length
        ? targetSegs[targetCol]!.index
        : lines[line - 1]!.length
    return new Cursor(this.text, offset + colOffset, this.columns)
  }

  down(): Cursor {
    const { line, column } = this.getPosition()
    const lines = this.text.split('\n')
    if (line >= lines.length - 1) return this
    let offset = 0
    for (let i = 0; i <= line; i++) {
      offset += lines[i]!.length + 1
    }
    const targetSegs = segmentGraphemes(lines[line + 1]!)
    const targetCol = Math.min(column, targetSegs.length)
    const colOffset =
      targetCol < targetSegs.length
        ? targetSegs[targetCol]!.index
        : lines[line + 1]!.length
    return new Cursor(this.text, offset + colOffset, this.columns)
  }

  prevWord(): Cursor {
    if (this.offset === 0) return this
    const segs = segmentGraphemes(this.text)
    let idx = segs.length - 1
    while (idx >= 0 && segs[idx]!.index >= this.offset) idx--
    while (idx >= 0 && !WORD_CHAR_RE.test(segs[idx]!.segment)) idx--
    while (idx > 0 && WORD_CHAR_RE.test(segs[idx - 1]!.segment)) idx--
    return new Cursor(this.text, idx >= 0 ? segs[idx]!.index : 0, this.columns)
  }

  nextWord(): Cursor {
    if (this.offset >= this.text.length) return this
    const segs = segmentGraphemes(this.text)
    let idx = 0
    while (idx < segs.length && segs[idx]!.index < this.offset) idx++
    while (idx < segs.length && WORD_CHAR_RE.test(segs[idx]!.segment)) idx++
    while (idx < segs.length && !WORD_CHAR_RE.test(segs[idx]!.segment)) idx++
    return new Cursor(
      this.text,
      idx < segs.length ? segs[idx]!.index : this.text.length,
      this.columns,
    )
  }

  insert(str: string): Cursor {
    if (str.length === 0) return this
    const nextText =
      this.text.slice(0, this.offset) + str + this.text.slice(this.offset)
    return new Cursor(nextText, this.offset + str.length, this.columns)
  }

  backspace(): Cursor {
    if (this.offset === 0) return this
    const prev = this.left()
    const nextText =
      this.text.slice(0, prev.offset) + this.text.slice(this.offset)
    return new Cursor(nextText, prev.offset, this.columns)
  }

  del(): Cursor {
    if (this.offset >= this.text.length) return this
    const next = this.right()
    const nextText =
      this.text.slice(0, this.offset) + this.text.slice(next.offset)
    return new Cursor(nextText, this.offset, this.columns)
  }

  deleteWordBefore(): Cursor {
    const start = this.prevWord()
    const nextText =
      this.text.slice(0, start.offset) + this.text.slice(this.offset)
    return new Cursor(nextText, start.offset, this.columns)
  }

  deleteToLineStart(): Cursor {
    const start = this.startOfLine()
    const nextText =
      this.text.slice(0, start.offset) + this.text.slice(this.offset)
    return new Cursor(nextText, start.offset, this.columns)
  }

  deleteToLineEnd(): Cursor {
    const end = this.endOfLine()
    const nextText =
      this.text.slice(0, this.offset) + this.text.slice(end.offset)
    return new Cursor(nextText, this.offset, this.columns)
  }
}
