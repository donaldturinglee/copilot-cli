import { getGraphemeSegmenter } from '../utilities/intl.js'

// Matches CSI, OSC (ST or BEL terminated), and 2-byte ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

/**
 * Strip ANSI escape sequences (CSI, OSC, and simple ESC sequences) from a string.
 */
export function stripAnsi(str: string): string {
  if (!str.includes('\x1b')) {
    return str
  }
  return str.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Determine East Asian display width (1 or 2) for a Unicode code point,
 * treating ambiguous-width characters as narrow (width 1) for Western terminal contexts.
 */
export function eastAsianWidth(codePoint: number): 1 | 2 {
  if (codePoint < 0x1100) {
    return 1
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo init. consonants
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x231a && codePoint <= 0x231b) || // Watch / Hourglass
    (codePoint >= 0x23e9 && codePoint <= 0x23ec) ||
    codePoint === 0x23f0 ||
    codePoint === 0x23f3 ||
    (codePoint >= 0x25fd && codePoint <= 0x25fe) ||
    (codePoint >= 0x2614 && codePoint <= 0x2615) ||
    (codePoint >= 0x2648 && codePoint <= 0x2653) ||
    codePoint === 0x267f ||
    codePoint === 0x2693 ||
    codePoint === 0x26a1 ||
    (codePoint >= 0x26aa && codePoint <= 0x26ab) ||
    (codePoint >= 0x26bd && codePoint <= 0x26be) ||
    (codePoint >= 0x26c4 && codePoint <= 0x26c5) ||
    codePoint === 0x26ce ||
    codePoint === 0x26d4 ||
    codePoint === 0x26ea ||
    (codePoint >= 0x26f2 && codePoint <= 0x26f3) ||
    codePoint === 0x26f5 ||
    codePoint === 0x26fa ||
    codePoint === 0x26fd ||
    codePoint === 0x2705 ||
    (codePoint >= 0x270a && codePoint <= 0x270b) ||
    codePoint === 0x2728 ||
    codePoint === 0x274c ||
    codePoint === 0x274e ||
    (codePoint >= 0x2753 && codePoint <= 0x2755) ||
    codePoint === 0x2757 ||
    (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    codePoint === 0x27b0 ||
    codePoint === 0x27bf ||
    (codePoint >= 0x2b1b && codePoint <= 0x2b1c) ||
    codePoint === 0x2b50 ||
    codePoint === 0x2b55 ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals .. CJK Symbols
    (codePoint >= 0x3040 && codePoint <= 0x3247) || // Hiragana, Katakana, Bopomofo, Enclosed CJK
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) || // Enclosed CJK .. CJK Ext A
    (codePoint >= 0x4e00 && codePoint <= 0xa4cf) || // CJK Unified Ideographs .. Yi
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Extended-A
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // Vertical forms
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK Compatibility Forms
    (codePoint >= 0xff01 && codePoint <= 0xff60) || // Fullwidth Forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth Currency/Symbols
    (codePoint >= 0x16fe0 && codePoint <= 0x16fe4) ||
    (codePoint >= 0x17000 && codePoint <= 0x187f7) || // Tangut
    (codePoint >= 0x18800 && codePoint <= 0x18cd5) ||
    (codePoint >= 0x1aff0 && codePoint <= 0x1b2fb) || // Kana Extended
    (codePoint >= 0x1f004 && codePoint <= 0x1f004) ||
    (codePoint >= 0x1f0cf && codePoint <= 0x1f0cf) ||
    (codePoint >= 0x1f18e && codePoint <= 0x1f18e) ||
    (codePoint >= 0x1f191 && codePoint <= 0x1f19a) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // Misc Symbols & Pictographs, Emoticons
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) || // Transport & Map
    (codePoint >= 0x1f900 && codePoint <= 0x1faff) || // Supplemental Symbols & Pictographs
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) || // CJK Ext B..F
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) // CJK Ext G+
  ) {
    return 2
  }
  return 1
}

export function isZeroWidth(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint < 0x7f) return false
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad

  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true

  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0xfeff ||
    (codePoint >= 0x2060 && codePoint <= 0x2064)
  ) {
    return true
  }

  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true
  }

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true
  }

  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    const offset = codePoint & 0x7f
    if (offset <= 0x03) return true
    if (offset >= 0x3a && offset <= 0x4f) return true
    if (offset >= 0x51 && offset <= 0x57) return true
    if (offset >= 0x62 && offset <= 0x63) return true
  }

  if (
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    codePoint === 0x0eb1 ||
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) ||
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd)
  ) {
    return true
  }

  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true
  }

  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true
  return false
}

function needsSegmentation(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i)!
    if (cp > 0xffff) i++
    if (cp >= 0x1f300 && cp <= 0x1faff) return true
    if (cp >= 0x2600 && cp <= 0x27bf) return true
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true
    if (cp === 0x200d) return true
    if (cp >= 0x0300 && cp <= 0x036f) return true
  }
  return false
}

function isEmojiGrapheme(grapheme: string): boolean {
  const first = grapheme.codePointAt(0)
  if (first === undefined) return false
  if (first >= 0x1f300 && first <= 0x1faff) return true
  if (first >= 0x1f1e6 && first <= 0x1f1ff) return true
  if (grapheme.includes('\ufe0f') || grapheme.includes('\u200d')) {
    return (
      (first >= 0x2300 && first <= 0x27bf) ||
      (first >= 0x1f000 && first <= 0x1faff) ||
      grapheme.includes('\u20e3')
    )
  }
  return false
}

function getEmojiWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0)!
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0
    for (const _ of grapheme) count++
    return count === 1 ? 1 : 2
  }

  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1)
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1
    }
  }

  return 2
}

/**
 * Compute the visual column width of a string as rendered in a terminal.
 * Handles ASCII fast paths, ANSI CSI/OSC sequences, CJK full-width glyphs,
 * combining marks, and emoji grapheme clusters.
 */
export function stringWidth(str: string): number {
  if (typeof str !== 'string' || str.length === 0) {
    return 0
  }

  // Fast path: pure ASCII without escape sequences
  let isPureAscii = true
  let asciiWidth = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 127 || code === 0x1b) {
      isPureAscii = false
      break
    }
    if (code > 0x1f) {
      asciiWidth++
    }
  }
  if (isPureAscii) {
    return asciiWidth
  }

  const stripped = str.includes('\x1b') ? stripAnsi(str) : str
  if (stripped.length === 0) {
    return 0
  }

  if (!needsSegmentation(stripped)) {
    let width = 0
    for (const ch of stripped) {
      const cp = ch.codePointAt(0)!
      if (!isZeroWidth(cp)) {
        width += eastAsianWidth(cp)
      }
    }
    return width
  }

  let width = 0
  for (const { segment: grapheme } of getGraphemeSegmenter().segment(stripped)) {
    if (isEmojiGrapheme(grapheme)) {
      width += getEmojiWidth(grapheme)
      continue
    }
    for (const ch of grapheme) {
      const cp = ch.codePointAt(0)!
      if (!isZeroWidth(cp)) {
        width += eastAsianWidth(cp)
        break
      }
    }
  }
  return width
}
