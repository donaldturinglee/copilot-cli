import React from 'react'
import { Box } from '../../ink/components/box.js'
import { useAppState, useSetAppState } from '../../state/app_state.js'
import { applySettingsChange } from '../../utilities/settings/apply_settings_change.js'
import { updateSettingsForSource } from '../../utilities/settings/settings.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'

export type SandboxDialogProps = {
  onClose: (summary?: string) => void
}

export function SandboxDialog({ onClose }: SandboxDialogProps): React.ReactNode {
  const settings = useAppState(s => s.settings)
  const setAppState = useSetAppState()
  const enabled = Boolean(settings.sandbox?.enabled)
  const autoAllow = Boolean(settings.sandbox?.autoAllowBashIfSandboxed)

  return (
    <Dialog
      title="Sandbox Configuration (/sandbox)"
      subtitle="Esc to close"
      width={72}
      overlayId="sandbox-dialog"
      onCancel={() => onClose()}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          OS Sandbox: {enabled ? 'Enabled' : 'Disabled'} · Auto-allow sandboxed
          Bash: {autoAllow ? 'ON' : 'OFF'}
        </ThemedText>
        <Select
          options={[
            {
              label: enabled ? 'Disable OS sandbox' : 'Enable OS sandbox',
              value: 'toggle_enabled',
            },
            {
              label: autoAllow
                ? 'Disable auto-allow for sandboxed Bash'
                : 'Enable auto-allow for sandboxed Bash',
              value: 'toggle_auto',
            },
            { label: 'Close', value: 'close' },
          ]}
          onChange={choice => {
            if (choice === 'toggle_enabled') {
              updateSettingsForSource('userSettings', {
                sandbox: { enabled: !enabled },
              })
              applySettingsChange('userSettings', setAppState)
              onClose(`Sandbox ${!enabled ? 'enabled' : 'disabled'}.`)
            } else if (choice === 'toggle_auto') {
              updateSettingsForSource('userSettings', {
                sandbox: { autoAllowBashIfSandboxed: !autoAllow },
              })
              applySettingsChange('userSettings', setAppState)
              onClose(
                `Sandbox auto-allow ${!autoAllow ? 'enabled' : 'disabled'}.`,
              )
            } else {
              onClose()
            }
          }}
        />
      </Box>
    </Dialog>
  )
}
