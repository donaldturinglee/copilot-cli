import { findEnclosingChip, snapCursorOutOfChip } from './image_chips.js'
import type { FindType } from './types.js'

export function clampNormalCursor(text: string, offset: number): number {
  if (text.length === 0) return 0
  return Math.max(0, Math.min(offset, text.length - 1))
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch)
}

function charClass(ch: string): 0 | 1 | 2 {
  if (isWhitespace(ch)) return 0
  if (isWordChar(ch)) return 1
  return 2
}

export function getLineBounds(
  text: string,
  offset: number,
): { start: number; end: number } {
  const safe = Math.max(0, Math.min(offset, text.length))
  const nlBefore = text.lastIndexOf('\n', safe - 1)
  const start = nlBefore === -1 ? 0 : nlBefore + 1
  const nlAfter = text.indexOf('\n', safe)
  const end = nlAfter === -1 ? text.length : nlAfter
  return { start, end }
}

function moveVertical(text: string, offset: number, delta: number): number {
  const lines = text.split('\n')
  let lineIdx = 0
  let lineStart = 0
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = lineStart + lines[i]!.length
    if (offset <= lineEnd || i === lines.length - 1) {
      lineIdx = i
      break
    }
    lineStart = lineEnd + 1
  }
  const col = offset - lineStart
  const targetLine = Math.max(0, Math.min(lines.length - 1, lineIdx + delta))
  let targetStart = 0
  for (let i = 0; i < targetLine; i++) {
    targetStart += lines[i]!.length + 1
  }
  const targetLen = lines[targetLine]!.length
  const targetCol = targetLen === 0 ? 0 : Math.min(col, targetLen - 1)
  return snapCursorOutOfChip(text, targetStart + targetCol, 'left')
}

function moveWordForward(
  text: string,
  offset: number,
  bigWord: boolean,
  forOperator: boolean,
): number {
  let pos = offset
  const n = text.length
  if (pos >= n) return n

  // Treat an atomic chip as a single whole word
  const startChip = findEnclosingChip(text, pos, true)
  if (startChip) {
    pos = startChip.end
    while (pos < n && isWhitespace(text[pos]!)) pos++
    return pos
  }

  if (bigWord) {
    while (pos < n && !isWhitespace(text[pos]!)) pos++
  } else {
    const cls = charClass(text[pos]!)
    if (cls !== 0) {
      while (pos < n && charClass(text[pos]!) === cls) pos++
    }
  }
  while (pos < n && isWhitespace(text[pos]!)) {
    if (forOperator && text[pos] === '\n') break
    pos++
  }
  return snapCursorOutOfChip(text, Math.min(pos, forOperator ? n : Math.max(0, n - 1)), 'right')
}

function moveWordBackward(
  text: string,
  offset: number,
  bigWord: boolean,
): number {
  let pos = offset
  if (pos <= 0) return 0
  pos--
  while (pos > 0 && isWhitespace(text[pos]!)) pos--
  const chip = findEnclosingChip(text, pos, true)
  if (chip) return chip.start
  if (bigWord) {
    while (pos > 0 && !isWhitespace(text[pos - 1]!)) pos--
  } else {
    const cls = charClass(text[pos]!)
    while (pos > 0 && charClass(text[pos - 1]!) === cls) pos--
  }
  return snapCursorOutOfChip(text, pos, 'left')
}

function moveWordEnd(
  text: string,
  offset: number,
  bigWord: boolean,
): number {
  let pos = offset
  const n = text.length
  if (pos >= n - 1) return Math.max(0, n - 1)
  pos++
  while (pos < n && isWhitespace(text[pos]!)) pos++
  const chip = findEnclosingChip(text, pos, true)
  if (chip) return Math.max(chip.start, chip.end - 1)
  if (bigWord) {
    while (pos < n - 1 && !isWhitespace(text[pos + 1]!)) pos++
  } else {
    const cls = charClass(text[pos]!)
    while (pos < n - 1 && charClass(text[pos + 1]!) === cls) pos++
  }
  return snapCursorOutOfChip(text, Math.min(pos, n - 1), 'right')
}

export type MotionResult = {
  cursor: number
  inclusive: boolean
  linewise: boolean
}

/**
 * Compute target cursor offset for a Vim motion (with count and chip boundary
 * snapping).
 */
export function resolveMotion(
  text: string,
  cursor: number,
  motion: string,
  count: number,
  forOperator = false,
): MotionResult {
  const n = text.length
  const c = Math.max(1, count)
  let pos = Math.max(0, Math.min(cursor, n))

  switch (motion) {
    case 'h': {
      for (let i = 0; i < c; i++) {
        if (pos > 0) {
          pos = snapCursorOutOfChip(text, pos - 1, 'left')
        }
      }
      return { cursor: pos, inclusive: false, linewise: false }
    }
    case 'l': {
      for (let i = 0; i < c; i++) {
        const chip = findEnclosingChip(text, pos, true)
        if (chip) {
          pos = forOperator ? chip.end : Math.min(Math.max(0, n - 1), chip.end)
        } else if (pos < (forOperator ? n : n - 1)) {
          pos = snapCursorOutOfChip(text, pos + 1, 'right')
        }
      }
      return { cursor: pos, inclusive: false, linewise: false }
    }
    case 'j':
      return {
        cursor: moveVertical(text, pos, c),
        inclusive: false,
        linewise: true,
      }
    case 'k':
      return {
        cursor: moveVertical(text, pos, -c),
        inclusive: false,
        linewise: true,
      }
    case 'w': {
      for (let i = 0; i < c; i++) {
        pos = moveWordForward(text, pos, false, forOperator)
      }
      return { cursor: pos, inclusive: false, linewise: false }
    }
    case 'W': {
      for (let i = 0; i < c; i++) {
        pos = moveWordForward(text, pos, true, forOperator)
      }
      return { cursor: pos, inclusive: false, linewise: false }
    }
    case 'b': {
      for (let i = 0; i < c; i++) {
        pos = moveWordBackward(text, pos, false)
      }
      return { cursor: pos, inclusive: false, linewise: false }
    }
    case 'B': {
      for (let i = 0; i < c; i++) {
        pos = moveWordBackward(text, pos, true)
      }
      return { cursor: pos, inclusive: false, linewise: false }
    }
    case 'e': {
      for (let i = 0; i < c; i++) {
        pos = moveWordEnd(text, pos, false)
      }
      return { cursor: pos, inclusive: true, linewise: false }
    }
    case 'E': {
      for (let i = 0; i < c; i++) {
        pos = moveWordEnd(text, pos, true)
      }
      return { cursor: pos, inclusive: true, linewise: false }
    }
    case '0': {
      const { start } = getLineBounds(text, pos)
      return { cursor: start, inclusive: false, linewise: false }
    }
    case '^': {
      const { start, end } = getLineBounds(text, pos)
      let p = start
      while (p < end && isWhitespace(text[p]!)) p++
      return { cursor: p, inclusive: false, linewise: false }
    }
    case '$': {
      const { end } = getLineBounds(text, pos)
      return {
        cursor: forOperator ? end : Math.max(0, end - 1),
        inclusive: true,
        linewise: false,
      }
    }
    case 'gg': {
      const lines = text.split('\n')
      const lineIdx = Math.max(0, Math.min(lines.length - 1, c - 1))
      let offset = 0
      for (let i = 0; i < lineIdx; i++) offset += lines[i]!.length + 1
      return { cursor: offset, inclusive: false, linewise: true }
    }
    case 'G': {
      const lines = text.split('\n')
      const targetLine = count > 1 ? Math.min(lines.length - 1, count - 1) : lines.length - 1
      let offset = 0
      for (let i = 0; i < targetLine; i++) offset += lines[i]!.length + 1
      return { cursor: offset, inclusive: false, linewise: true }
    }
    default:
      return { cursor: pos, inclusive: false, linewise: false }
  }
}

/**
 * Compute target offset for single-line character find motions (`f/F/t/T`).
 */
export function resolveFindMotion(
  text: string,
  cursor: number,
  findType: FindType,
  targetChar: string,
  count: number,
): { found: boolean; cursor: number; inclusive: boolean } {
  const { start, end } = getLineBounds(text, cursor)
  const forward = findType === 'f' || findType === 't'
  let pos = cursor
  let foundPos = -1

  for (let step = 0; step < Math.max(1, count); step++) {
    if (forward) {
      let idx = -1
      for (let i = pos + 1; i < end; i++) {
        if (text[i] === targetChar) {
          idx = i
          break
        }
      }
      if (idx === -1) return { found: false, cursor, inclusive: forward }
      foundPos = idx
      pos = idx
    } else {
      let idx = -1
      for (let i = pos - 1; i >= start; i--) {
        if (text[i] === targetChar) {
          idx = i
          break
        }
      }
      if (idx === -1) return { found: false, cursor, inclusive: forward }
      foundPos = idx
      pos = idx
    }
  }

  let finalPos = foundPos
  if (findType === 't') finalPos = Math.max(start, foundPos - 1)
  if (findType === 'T') finalPos = Math.min(end - 1, foundPos + 1)

  return {
    found: true,
    cursor: snapCursorOutOfChip(text, finalPos, forward ? 'right' : 'left'),
    inclusive: forward,
  }
}
