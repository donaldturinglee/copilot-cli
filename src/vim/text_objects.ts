import { expandRangeAcrossChips } from './image_chips.js'
import { getLineBounds } from './motions.js'
import type { TextObjectScope } from './types.js'

const PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
}

const QUOTES = new Set(['"', "'", '`'])

export type TextObjectRange = {
  start: number
  end: number
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function resolveWordObject(
  text: string,
  cursor: number,
  scope: TextObjectScope,
  bigWord: boolean,
): TextObjectRange | null {
  const n = text.length
  if (n === 0) return null
  const pos = Math.max(0, Math.min(cursor, n - 1))
  const inClass = (ch: string) =>
    bigWord ? !/\s/.test(ch) : isWordChar(ch)

  let start = pos
  let end = pos + 1

  if (/\s/.test(text[pos]!)) {
    while (start > 0 && /\s/.test(text[start - 1]!)) start--
    while (end < n && /\s/.test(text[end]!)) end++
  } else if (inClass(text[pos]!)) {
    while (start > 0 && inClass(text[start - 1]!)) start--
    while (end < n && inClass(text[end]!)) end++
    if (scope === 'around') {
      const prevEnd = end
      while (end < n && /[ \t]/.test(text[end]!)) end++
      if (end === prevEnd) {
        while (start > 0 && /[ \t]/.test(text[start - 1]!)) start--
      }
    }
  } else {
    while (
      start > 0 &&
      !/\s/.test(text[start - 1]!) &&
      !inClass(text[start - 1]!)
    ) {
      start--
    }
    while (end < n && !/\s/.test(text[end]!) && !inClass(text[end]!)) {
      end++
    }
    if (scope === 'around') {
      while (end < n && /[ \t]/.test(text[end]!)) end++
    }
  }

  return expandRangeAcrossChips(text, start, end)
}

function resolveQuoteObject(
  text: string,
  cursor: number,
  quote: string,
  scope: TextObjectScope,
): TextObjectRange | null {
  const { start: lineStart, end: lineEnd } = getLineBounds(text, cursor)
  const positions: number[] = []
  for (let i = lineStart; i < lineEnd; i++) {
    if (text[i] === quote && (i === lineStart || text[i - 1] !== '\\')) {
      positions.push(i)
    }
  }
  if (positions.length < 2) return null

  // Prefer pair enclosing cursor; otherwise first pair on or after cursor
  let openIdx = -1
  let closeIdx = -1
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const a = positions[i]!
    const b = positions[i + 1]!
    if (cursor >= a && cursor <= b) {
      openIdx = a
      closeIdx = b
      break
    }
    if (openIdx === -1 && a >= cursor) {
      openIdx = a
      closeIdx = b
      break
    }
  }
  if (openIdx === -1 || closeIdx === -1) return null

  const rangeStart = scope === 'inner' ? openIdx + 1 : openIdx
  const rangeEnd = scope === 'inner' ? closeIdx : closeIdx + 1
  return expandRangeAcrossChips(text, rangeStart, rangeEnd)
}

function resolveBracketObject(
  text: string,
  cursor: number,
  openCh: string,
  closeCh: string,
  scope: TextObjectScope,
): TextObjectRange | null {
  // Search backwards for matching unmatched open delimiter
  let depth = 0
  let openIdx = -1
  for (let i = cursor; i >= 0; i--) {
    if (text[i] === closeCh && i !== cursor) depth++
    else if (text[i] === openCh) {
      if (depth === 0) {
        openIdx = i
        break
      }
      depth--
    }
  }

  // Fallback: look forward on current line for opening delimiter
  if (openIdx === -1) {
    const { end: lineEnd } = getLineBounds(text, cursor)
    for (let i = cursor; i < lineEnd; i++) {
      if (text[i] === openCh) {
        openIdx = i
        break
      }
    }
  }
  if (openIdx === -1) return null

  depth = 0
  let closeIdx = -1
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === openCh) depth++
    else if (text[i] === closeCh) {
      if (depth === 0) {
        closeIdx = i
        break
      }
      depth--
    }
  }
  if (closeIdx === -1) return null

  const rangeStart = scope === 'inner' ? openIdx + 1 : openIdx
  const rangeEnd = scope === 'inner' ? closeIdx : closeIdx + 1
  return expandRangeAcrossChips(text, rangeStart, rangeEnd)
}

/**
 * Resolve Vim text objects (`iw/aw/iW/aW`, quotes `i"/a"/i'/a'/i`/a\``,
 * brackets `i(/a(/i[/a[/i{/a{/i</a</ib/ab/iB/aB`).
 */
export function resolveTextObject(
  text: string,
  cursor: number,
  scope: TextObjectScope,
  objChar: string,
): TextObjectRange | null {
  if (objChar === 'w') return resolveWordObject(text, cursor, scope, false)
  if (objChar === 'W') return resolveWordObject(text, cursor, scope, true)
  if (QUOTES.has(objChar)) {
    return resolveQuoteObject(text, cursor, objChar, scope)
  }
  const pair = PAIRS[objChar]
  if (pair) {
    return resolveBracketObject(text, cursor, pair[0], pair[1], scope)
  }
  return null
}
