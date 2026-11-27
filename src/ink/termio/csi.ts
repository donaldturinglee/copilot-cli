import { CSI } from './ansi.js'

/**
 * CSI (Control Sequence Introducer) sequence builders and constants.
 */

export const CURSOR_HOME = `${CSI}H`
export const ERASE_TO_END_OF_LINE = `${CSI}K`
export const ERASE_ENTIRE_LINE = `${CSI}2K`
export const ERASE_TO_END_OF_SCREEN = `${CSI}J`
export const ERASE_ENTIRE_SCREEN = `${CSI}2J`
export const ERASE_SCROLLBACK = `${CSI}3J`
export const CLEAR_TERMINAL = `${ERASE_ENTIRE_SCREEN}${ERASE_SCROLLBACK}${CURSOR_HOME}`

export const RESET_SCROLL_REGION = `${CSI}r`

// Bracketed paste markers
export const PASTE_START = `${CSI}200~`
export const PASTE_END = `${CSI}201~`

// Focus event markers
export const FOCUS_IN = `${CSI}I`
export const FOCUS_OUT = `${CSI}O`

// Device queries
export const QUERY_DA1 = `${CSI}c`
export const QUERY_DA2 = `${CSI}>c`
export const QUERY_XTVERSION = `${CSI}>0q`
export const QUERY_KITTY_KEYBOARD = `${CSI}?u`
export const QUERY_CURSOR_POSITION = `${CSI}6n`

/**
 * Push Kitty keyboard protocol flags (disambiguate escape codes = 1).
 */
export function pushKittyKeyboard(flags = 1): string {
  return `${CSI}>${flags}u`
}

export function popKittyKeyboard(count = 1): string {
  return `${CSI}<${count}u`
}

/**
 * Move cursor to 1-based (row, col) absolute position (CUP).
 */
export function cursorTo(row: number, col = 1): string {
  const r = Math.max(1, Math.floor(row))
  const c = Math.max(1, Math.floor(col))
  if (r === 1 && c === 1) return CURSOR_HOME
  return `${CSI}${r};${c}H`
}

export function cursorHorizontalAbsolute(col: number): string {
  const c = Math.max(1, Math.floor(col))
  return c === 1 ? `${CSI}G` : `${CSI}${c}G`
}

export function cursorUp(n = 1): string {
  if (n <= 0) return ''
  return n === 1 ? `${CSI}A` : `${CSI}${n}A`
}

export function cursorDown(n = 1): string {
  if (n <= 0) return ''
  return n === 1 ? `${CSI}B` : `${CSI}${n}B`
}

export function cursorForward(n = 1): string {
  if (n <= 0) return ''
  return n === 1 ? `${CSI}C` : `${CSI}${n}C`
}

export function cursorBackward(n = 1): string {
  if (n <= 0) return ''
  return n === 1 ? `${CSI}D` : `${CSI}${n}D`
}

export function cursorMove(dx: number, dy: number): string {
  let out = ''
  if (dx < 0) out += cursorBackward(-dx)
  else if (dx > 0) out += cursorForward(dx)
  if (dy < 0) out += cursorUp(-dy)
  else if (dy > 0) out += cursorDown(dy)
  return out
}

export function eraseLines(count: number): string {
  if (count <= 0) return ''
  let out = ''
  for (let i = 0; i < count; i++) {
    out += ERASE_ENTIRE_LINE + (i < count - 1 ? cursorUp(1) : '')
  }
  out += cursorHorizontalAbsolute(1)
  return out
}

/**
 * DECSTBM — Set Top and Bottom Margins (1-based inclusive rows).
 */
export function setScrollRegion(top: number, bottom: number): string {
  return `${CSI}${Math.max(1, top)};${Math.max(1, bottom)}r`
}

/**
 * SU — Scroll Up by `n` lines within the active scroll region.
 */
export function scrollUp(n = 1): string {
  if (n <= 0) return ''
  return n === 1 ? `${CSI}S` : `${CSI}${n}S`
}

/**
 * SD — Scroll Down by `n` lines within the active scroll region.
 */
export function scrollDown(n = 1): string {
  if (n <= 0) return ''
  return n === 1 ? `${CSI}T` : `${CSI}${n}T`
}

/**
 * DECSCUSR — Set Cursor Style.
 */
export function setCursorStyle(
  style: 0 | 1 | 2 | 3 | 4 | 5 | 6,
): string {
  return `${CSI}${style} q`
}
