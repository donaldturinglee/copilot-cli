import { CSI } from './ansi.js'
import type { ColorSpec } from './types.js'

/**
 * SGR (Select Graphic Rendition) sequence builders and helpers.
 */

export const SGR_RESET = `${CSI}0m`
export const SGR_BOLD = `${CSI}1m`
export const SGR_DIM = `${CSI}2m`
export const SGR_ITALIC = `${CSI}3m`
export const SGR_UNDERLINE = `${CSI}4m`
export const SGR_INVERSE = `${CSI}7m`
export const SGR_STRIKETHROUGH = `${CSI}9m`

export const SGR_NO_BOLD_OR_DIM = `${CSI}22m`
export const SGR_NO_ITALIC = `${CSI}23m`
export const SGR_NO_UNDERLINE = `${CSI}24m`
export const SGR_NO_INVERSE = `${CSI}27m`
export const SGR_NO_STRIKETHROUGH = `${CSI}29m`

export const SGR_DEFAULT_FG = `${CSI}39m`
export const SGR_DEFAULT_BG = `${CSI}49m`

export function sgr(...codes: number[]): string {
  return `${CSI}${codes.join(';')}m`
}

export function fgRgb(r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m`
}

export function bgRgb(r: number, g: number, b: number): string {
  return `${CSI}48;2;${r};${g};${b}m`
}

export function fg256(index: number): string {
  return `${CSI}38;5;${index}m`
}

export function bg256(index: number): string {
  return `${CSI}48;5;${index}m`
}

export function colorSpecToSgr(color: ColorSpec, isBg: boolean): string {
  switch (color.type) {
    case 'default':
      return isBg ? SGR_DEFAULT_BG : SGR_DEFAULT_FG
    case 'ansi': {
      const idx = color.index
      if (idx < 8) return `${CSI}${(isBg ? 40 : 30) + idx}m`
      return `${CSI}${(isBg ? 100 : 90) + (idx - 8)}m`
    }
    case 'ansi256':
      return isBg ? bg256(color.index) : fg256(color.index)
    case 'rgb':
      return isBg ? bgRgb(color.r, color.g, color.b) : fgRgb(color.r, color.g, color.b)
  }
}

/**
 * Determine whether an SGR escape sequence produces a visible effect on space
 * characters (background color, inverse video, underline, strikethrough).
 */
export function sgrVisibleOnSpace(code: string): boolean {
  if (!code.startsWith('\x1b[') || !code.endsWith('m')) return false
  const body = code.slice(2, -1)
  if (!body) return false
  const params = body.split(';').map(p => (p === '' ? 0 : parseInt(p, 10)))
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 4 || p === 7 || p === 9) return true
    if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) return true
    if (p === 48) return true
    if (p === 38) {
      // Skip 38;5;n or 38;2;r;g;b so fg parameters aren't misread
      const mode = params[i + 1]
      if (mode === 5) i += 2
      else if (mode === 2) i += 4
    }
  }
  return false
}
