import React from 'react'
import { Box } from '../ink/components/box.js'
import type { ThemeName } from '../types/forward.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { useTheme } from './design_system/theme_provider.js'
import { ThemedText } from './design_system/themed_text.js'

const THEME_OPTIONS: ReadonlyArray<{ label: string; value: ThemeName; description: string }> = [
  { label: 'Dark', value: 'dark', description: 'Default high-contrast dark theme' },
  { label: 'Light', value: 'light', description: 'Crisp light terminal theme' },
  { label: 'Dark (Daltonized)', value: 'dark-daltonized', description: 'Colorblind-friendly dark palette' },
  { label: 'Light (Daltonized)', value: 'light-daltonized', description: 'Colorblind-friendly light palette' },
  { label: 'Dark (ANSI)', value: 'dark-ansi', description: '16-color ANSI dark theme' },
  { label: 'Light (ANSI)', value: 'light-ansi', description: '16-color ANSI light theme' },
]

export type ThemePickerProps = {
  onSelect: (theme: ThemeName) => void
  onCancel: () => void
}

export function ThemePicker({
  onSelect,
  onCancel,
}: ThemePickerProps): React.ReactNode {
  const [currentTheme, setTheme] = useTheme()

  return (
    <Dialog
      title="Select Theme (/theme)"
      subtitle={`Current: ${currentTheme}`}
      width={68}
      overlayId="theme-picker"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Select
          defaultValue={currentTheme}
          options={THEME_OPTIONS}
          onFocus={t => setTheme(t)}
          onChange={t => {
            setTheme(t)
            onSelect(t)
          }}
          onCancel={onCancel}
        />
        <ThemedText dimColor>Live preview updates as you navigate.</ThemedText>
      </Box>
    </Dialog>
  )
}
