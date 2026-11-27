import { getTheme, type Theme, type ThemeName } from '../utilities/theme.js'
import { bgRgb, fgRgb, SGR_DEFAULT_BG, SGR_DEFAULT_FG } from './termio/sgr.js'

const ANSI_FG_MAP: Record<string, string> = {
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  grey: '\x1b[90m',
  blackBright: '\x1b[90m',
  redBright: '\x1b[91m',
  greenBright: '\x1b[92m',
  yellowBright: '\x1b[93m',
  blueBright: '\x1b[94m',
  magentaBright: '\x1b[95m',
  cyanBright: '\x1b[96m',
  whiteBright: '\x1b[97m',
}

const ANSI_BG_MAP: Record<string, string> = {
  black: '\x1b[40m',
  red: '\x1b[41m',
  green: '\x1b[42m',
  yellow: '\x1b[43m',
  blue: '\x1b[44m',
  magenta: '\x1b[45m',
  cyan: '\x1b[46m',
  white: '\x1b[47m',
  gray: '\x1b[100m',
  grey: '\x1b[100m',
  blackBright: '\x1b[100m',
  redBright: '\x1b[101m',
  greenBright: '\x1b[102m',
  yellowBright: '\x1b[103m',
  blueBright: '\x1b[104m',
  magentaBright: '\x1b[105m',
  cyanBright: '\x1b[106m',
  whiteBright: '\x1b[107m',
}

const RGB_RE = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i
const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i

/**
 * Resolve a color token (theme token, `rgb(r,g,b)`, `#rrggbb`, `ansi:name`, or
 * named ANSI color) to its opening SGR escape sequence.
 */
export function resolveColorToSgr(
  color: string | undefined,
  type: 'foreground' | 'background',
  themeName: ThemeName = 'dark',
): string | null {
  if (!color) return null

  const theme = getTheme(themeName)
  const resolved =
    color in theme ? theme[color as keyof Theme] : color

  const isBg = type === 'background'

  if (resolved.startsWith('ansi:')) {
    const name = resolved.slice(5)
    return (isBg ? ANSI_BG_MAP[name] : ANSI_FG_MAP[name]) ?? null
  }

  const rgbMatch = RGB_RE.exec(resolved)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]!, 10)
    const g = parseInt(rgbMatch[2]!, 10)
    const b = parseInt(rgbMatch[3]!, 10)
    return isBg ? bgRgb(r, g, b) : fgRgb(r, g, b)
  }

  const hexMatch = HEX_RE.exec(resolved)
  if (hexMatch) {
    let hex = hexMatch[1]!
    if (hex.length === 3) {
      hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!
    }
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return isBg ? bgRgb(r, g, b) : fgRgb(r, g, b)
  }

  return (isBg ? ANSI_BG_MAP[resolved] : ANSI_FG_MAP[resolved]) ?? null
}

/**
 * Wrap `text` with opening and closing SGR color codes.
 */
export function colorize(
  text: string,
  color: string | undefined,
  type: 'foreground' | 'background',
  themeName: ThemeName = 'dark',
): string {
  const open = resolveColorToSgr(color, type, themeName)
  if (!open) return text
  const close = type === 'background' ? SGR_DEFAULT_BG : SGR_DEFAULT_FG
  return `${open}${text}${close}`
}
