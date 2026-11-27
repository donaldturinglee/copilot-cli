import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { InkThemeNameContext } from '../../ink/components/text.js'
import {
  resolveThemeSetting,
  subscribeSystemTheme,
} from '../../utilities/system_theme.js'
import {
  getTheme,
  type Theme,
  type ThemeName,
  type ThemeSetting,
} from '../../utilities/theme.js'

export type ThemeContextValue = {
  theme: ThemeName
  themeSetting: ThemeSetting
  palette: Theme
  setTheme: (next: ThemeSetting) => void
  setPreviewTheme: (preview: ThemeSetting | null) => void
  savePreview: () => void
  cancelPreview: () => void
  previewTheme: ThemeSetting | null
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  themeSetting: 'dark',
  palette: getTheme('dark'),
  setTheme: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  previewTheme: null,
})

export type ThemeProviderProps = {
  initialTheme?: ThemeSetting
  onThemeChange?: (theme: ThemeSetting) => void
  children: React.ReactNode
}

/**
 * 6-theme Design System provider supporting `'auto'` OS theme tracking and
 * non-destructive live preview mode (`setPreviewTheme` / `savePreview` / `cancelPreview`).
 */
export function ThemeProvider({
  initialTheme = 'dark',
  onThemeChange,
  children,
}: ThemeProviderProps): React.ReactNode {
  const [themeSetting, setThemeSettingState] =
    useState<ThemeSetting>(initialTheme)
  const [previewTheme, setPreviewTheme] = useState<ThemeSetting | null>(null)
  const [, setSystemVersion] = useState(0)

  useEffect(() => {
    return subscribeSystemTheme(() => {
      setSystemVersion(v => v + 1)
    })
  }, [])

  const setTheme = useCallback(
    (next: ThemeSetting) => {
      setThemeSettingState(next)
      setPreviewTheme(null)
      onThemeChange?.(next)
    },
    [onThemeChange],
  )

  const savePreview = useCallback(() => {
    if (previewTheme !== null) {
      setTheme(previewTheme)
    }
  }, [previewTheme, setTheme])

  const cancelPreview = useCallback(() => {
    setPreviewTheme(null)
  }, [])

  const activeSetting = previewTheme ?? themeSetting
  const resolvedTheme = resolveThemeSetting(activeSetting)
  const palette = useMemo(() => getTheme(resolvedTheme), [resolvedTheme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolvedTheme,
      themeSetting,
      palette,
      setTheme,
      setPreviewTheme,
      savePreview,
      cancelPreview,
      previewTheme,
    }),
    [
      resolvedTheme,
      themeSetting,
      palette,
      setTheme,
      savePreview,
      cancelPreview,
      previewTheme,
    ],
  )

  return (
    <ThemeContext.Provider value={value}>
      <InkThemeNameContext.Provider value={resolvedTheme}>
        {children}
      </InkThemeNameContext.Provider>
    </ThemeContext.Provider>
  )
}

export function useTheme(): [ThemeName, (theme: ThemeSetting) => void] {
  const ctx = useContext(ThemeContext)
  return [ctx.theme, ctx.setTheme]
}

export function useThemeSetting(): ThemeSetting {
  return useContext(ThemeContext).themeSetting
}

export function useCurrentTheme(): Theme {
  return useContext(ThemeContext).palette
}

export function usePreviewTheme(): {
  previewTheme: ThemeSetting | null
  setPreviewTheme: (preview: ThemeSetting | null) => void
  savePreview: () => void
  cancelPreview: () => void
} {
  const ctx = useContext(ThemeContext)
  return {
    previewTheme: ctx.previewTheme,
    setPreviewTheme: ctx.setPreviewTheme,
    savePreview: ctx.savePreview,
    cancelPreview: ctx.cancelPreview,
  }
}
