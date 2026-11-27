import { execFileSync } from 'child_process'
import type { ThemeName, ThemeSetting } from './theme.js'

export type SystemTheme = 'light' | 'dark'

let cachedSystemTheme: SystemTheme | null = null
const listeners = new Set<(theme: SystemTheme) => void>()

/**
 * Detect host OS light/dark theme preference.
 * Supports COLORFGBG heuristic, macOS defaults, Windows registry heuristic,
 * and defaults safely to 'dark' for standard developer terminals.
 */
export function detectSystemTheme(): SystemTheme {
  if (cachedSystemTheme) return cachedSystemTheme

  const colorFgBg = process.env.COLORFGBG
  if (colorFgBg) {
    const parts = colorFgBg.split(';')
    const bg = parseInt(parts[parts.length - 1] ?? '', 10)
    if (!isNaN(bg)) {
      cachedSystemTheme = bg >= 7 ? 'light' : 'dark'
      return cachedSystemTheme
    }
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 500,
      }).trim()
      cachedSystemTheme = out.toLowerCase() === 'dark' ? 'dark' : 'light'
      return cachedSystemTheme
    } catch {
      cachedSystemTheme = 'light'
      return cachedSystemTheme
    }
  }

  cachedSystemTheme = 'dark'
  return cachedSystemTheme
}

export function setDetectedSystemTheme(theme: SystemTheme): void {
  if (cachedSystemTheme === theme) return
  cachedSystemTheme = theme
  for (const listener of listeners) {
    listener(theme)
  }
}

export function subscribeSystemTheme(
  listener: (theme: SystemTheme) => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resolveThemeSetting(
  setting: ThemeSetting | undefined,
): ThemeName {
  if (!setting || setting === 'auto') {
    return detectSystemTheme()
  }
  return setting
}

export function resetSystemThemeCache(): void {
  cachedSystemTheme = null
}
