import React from 'react'
import { Box } from '../ink/components/box.js'
import { saveGlobalConfig } from '../utilities/config.js'
import { THEME_NAMES, type ThemeName } from '../utilities/theme.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'
import { usePreviewTheme, useTheme } from './design_system/theme_provider.js'

export type OnboardingProps = {
  onComplete: (selectedTheme: ThemeName) => void
  onCancel?: () => void
  persist?: boolean
}

export function Onboarding({
  onComplete,
  onCancel,
  persist = true,
}: OnboardingProps): React.ReactNode {
  const [currentTheme, setTheme] = useTheme()
  const { setPreviewTheme } = usePreviewTheme()

  const handleSelect = (themeName: ThemeName): void => {
    setTheme(themeName)
    if (persist) {
      saveGlobalConfig(prev => ({
        ...prev,
        theme: themeName,
        hasCompletedOnboarding: true,
      }))
    }
    onComplete(themeName)
  }

  return (
    <Dialog
      title="Welcome to Copilot CLI"
      subtitle="Choose your terminal theme"
      borderColor="claude"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          Pick a color theme that looks crisp in your terminal (you can change
          it anytime with /theme):
        </ThemedText>
        <Select<ThemeName>
          defaultValue={currentTheme}
          options={THEME_NAMES.map(t => ({ label: t, value: t }))}
          onFocus={t => setPreviewTheme(t)}
          onChange={handleSelect}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
