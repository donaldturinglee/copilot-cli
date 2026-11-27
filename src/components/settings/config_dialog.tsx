import React, { useState } from 'react'
import { Box } from '../../ink/components/box.js'
import { useAppState, useSetAppState } from '../../state/app_state.js'
import { saveGlobalConfig } from '../../utilities/config.js'
import { applySettingsChange } from '../../utilities/settings/apply_settings_change.js'
import { updateSettingsForSource } from '../../utilities/settings/settings.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { Tab, Tabs } from '../design_system/tabs.js'
import { useTheme } from '../design_system/theme_provider.js'
import { ThemedText } from '../design_system/themed_text.js'

export type ConfigDialogProps = {
  initialTab?: 'general' | 'permissions' | 'display'
  onClose: (summary?: string) => void
}

/**
 * 3-tab `/config` settings UI (`General` / `Permissions` / `Display`).
 */
export function ConfigDialog({
  initialTab = 'general',
  onClose,
}: ConfigDialogProps): React.ReactNode {
  const [activeTab, setActiveTab] = useState<string>(initialTab)
  const [theme, setTheme] = useTheme()
  const settings = useAppState(s => s.settings)
  const verbose = useAppState(s => s.verbose)
  const thinkingEnabled = useAppState(s => s.thinkingEnabled)
  const permMode = useAppState(s => s.toolPermissionContext.mode)
  const setAppState = useSetAppState()

  const toggleSetting = (key: 'verbose' | 'thinking' | 'fastMode') => {
    if (key === 'verbose') {
      const next = !verbose
      setAppState(prev => ({ ...prev, verbose: next }))
      updateSettingsForSource('userSettings', { verbose: next })
      applySettingsChange('userSettings', setAppState)
    } else if (key === 'thinking') {
      const next = !thinkingEnabled
      setAppState(prev => ({ ...prev, thinkingEnabled: next }))
      updateSettingsForSource('userSettings', { alwaysThinkingEnabled: next })
      applySettingsChange('userSettings', setAppState)
    } else {
      setAppState(prev => ({ ...prev, fastMode: !prev.fastMode }))
    }
  }

  return (
    <Dialog
      title="Copilot Configuration (/config)"
      subtitle="Left/Right or Tab to switch tabs · Enter to toggle · Esc to close"
      width={72}
      overlayId="config-dialog"
      onCancel={() => onClose()}
    >
      <Tabs activeTabId={activeTab} onTabChange={setActiveTab}>
        <Tab id="general" title="General">
          <Box flexDirection="column" gap={1}>
            <Select
              isDisabled={activeTab !== 'general'}
              options={[
                {
                  label: `Verbose output: ${verbose ? 'ON' : 'OFF'}`,
                  value: 'verbose',
                },
                {
                  label: `Extended thinking: ${thinkingEnabled ? 'ON' : 'OFF'}`,
                  value: 'thinking',
                },
                {
                  label: `Fast mode: ${settings.fastMode ? 'ON' : 'OFF'}`,
                  value: 'fastMode',
                },
                {
                  label: `Output style: ${settings.outputStyle ?? 'default'}`,
                  value: 'outputStyle',
                },
                { label: 'Close', value: 'close' },
              ]}
              onChange={val => {
                if (val === 'close') onClose('Configuration updated.')
                else if (val === 'outputStyle') {
                  const nextStyle =
                    settings.outputStyle === 'explanatory'
                      ? 'default'
                      : 'explanatory'
                  updateSettingsForSource('userSettings', {
                    outputStyle: nextStyle,
                  })
                  applySettingsChange('userSettings', setAppState)
                } else {
                  toggleSetting(val as 'verbose' | 'thinking' | 'fastMode')
                }
              }}
            />
          </Box>
        </Tab>

        <Tab id="permissions" title="Permissions">
          <Box flexDirection="column" gap={1}>
            <ThemedText dimColor>Current mode: {permMode}</ThemedText>
            <ThemedText dimColor>
              Allow rules: {settings.permissions?.allow?.length ?? 0} · Deny
              rules: {settings.permissions?.deny?.length ?? 0}
            </ThemedText>
            <Select
              isDisabled={activeTab !== 'permissions'}
              options={[
                { label: 'Mode: default (ask before edits/shell)', value: 'default' },
                { label: 'Mode: acceptEdits (auto-approve workspace edits)', value: 'acceptEdits' },
                { label: 'Mode: plan (read-only planning mode)', value: 'plan' },
                { label: 'Mode: dontAsk (fail-closed non-interactive)', value: 'dontAsk' },
                { label: 'Close', value: 'close' },
              ]}
              onChange={val => {
                if (val === 'close') {
                  onClose('Permissions updated.')
                  return
                }
                const mode = val as 'default' | 'acceptEdits' | 'plan' | 'dontAsk'
                setAppState(prev => ({
                  ...prev,
                  toolPermissionContext: {
                    ...prev.toolPermissionContext,
                    mode,
                  },
                }))
                updateSettingsForSource('userSettings', {
                  permissions: { defaultMode: mode },
                })
                applySettingsChange('userSettings', setAppState)
              }}
            />
          </Box>
        </Tab>

        <Tab id="display" title="Display">
          <Box flexDirection="column" gap={1}>
            <ThemedText dimColor>Current theme: {theme}</ThemedText>
            <Select
              isDisabled={activeTab !== 'display'}
              options={[
                { label: 'Theme: dark', value: 'dark' },
                { label: 'Theme: light', value: 'light' },
                { label: 'Theme: dark-daltonized', value: 'dark-daltonized' },
                { label: 'Theme: light-daltonized', value: 'light-daltonized' },
                { label: 'Close', value: 'close' },
              ]}
              onChange={val => {
                if (val === 'close') {
                  onClose('Display settings saved.')
                  return
                }
                const nextTheme = val as
                  | 'dark'
                  | 'light'
                  | 'dark-daltonized'
                  | 'light-daltonized'
                setTheme(nextTheme)
                saveGlobalConfig(prev => ({ ...prev, theme: nextTheme }))
              }}
            />
          </Box>
        </Tab>
      </Tabs>
    </Dialog>
  )
}
