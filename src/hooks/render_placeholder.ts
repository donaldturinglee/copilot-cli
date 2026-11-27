import { colorize } from '../ink/colorize.js'
import type { ThemeName } from '../utilities/theme.js'

export type PlaceholderOptions = {
  placeholder: string
  showCursor?: boolean
  themeName?: ThemeName
}

export function renderPlaceholder({
  placeholder,
  showCursor = true,
  themeName = 'dark',
}: PlaceholderOptions): string {
  if (placeholder.length === 0) {
    return showCursor ? '\x1b[7m \x1b[27m' : ''
  }
  const first = placeholder[0]!
  const rest = placeholder.slice(1)
  if (showCursor) {
    return `\x1b[7m${first}\x1b[27m${colorize(rest, 'inactive', 'foreground', themeName)}`
  }
  return colorize(placeholder, 'inactive', 'foreground', themeName)
}
