import React from 'react'
import { Box } from '../../ink/components/box.js'
import { useAppState } from '../../state/app_state.js'
import { getHooksConfigFromSnapshot } from '../../utilities/hooks/hooks_config_snapshot.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'

export type HooksDialogProps = {
  onClose: () => void
}

export function HooksDialog({ onClose }: HooksDialogProps): React.ReactNode {
  const settings = useAppState(s => s.settings)
  const snapshot = getHooksConfigFromSnapshot() ?? settings.hooks ?? {}
  const entries = Object.entries(snapshot).filter(
    ([, matchers]) => Array.isArray(matchers) && matchers.length > 0,
  )

  return (
    <Dialog
      title="Configured Lifecycle Hooks (/hooks)"
      subtitle="Esc to close"
      width={72}
      overlayId="hooks-dialog"
      onCancel={onClose}
    >
      {entries.length === 0 ? (
        <ThemedText dimColor>
          No lifecycle hooks configured in settings.json.
        </ThemedText>
      ) : (
        <Box flexDirection="column" gap={0}>
          {entries.map(([event, matchers]) => (
            <Box key={event} flexDirection="row" gap={1}>
              <ThemedText color="suggestion" bold>
                {event}
              </ThemedText>
              <ThemedText dimColor>
                ({Array.isArray(matchers) ? matchers.length : 0} matcher
                {Array.isArray(matchers) && matchers.length === 1 ? '' : 's'})
              </ThemedText>
            </Box>
          ))}
        </Box>
      )}
    </Dialog>
  )
}
