import { getTheme, type Theme, type ThemeName } from '../../utilities/theme.js'

export type ThemeColorKey = keyof Theme

export function resolveThemeColor(
  color: ThemeColorKey | string | undefined,
  themeName: ThemeName = 'dark',
): string | undefined {
  if (!color) return undefined
  const theme = getTheme(themeName)
  if (color in theme) {
    return theme[color as ThemeColorKey]
  }
  return color
}

export function getThemePalette(themeName: ThemeName): Theme {
  return getTheme(themeName)
}
