import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type AutoModeOptInDialogProps = {
  onAccept: () => void
  onDecline: () => void
}

export function AutoModeOptInDialog({
  onAccept,
  onDecline,
}: AutoModeOptInDialogProps): React.ReactNode {
  return (
    <Dialog
      title="Enable Auto Permission Mode?"
      borderColor="autoAccept"
      onCancel={onDecline}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          Auto mode evaluates tool actions with a safety classifier before
          executing and pauses if consecutive denials trip the circuit breaker.
        </ThemedText>
        <Select<'accept' | 'decline'>
          options={[
            { label: 'Enable Auto mode', value: 'accept' },
            { label: 'Keep Default mode', value: 'decline' },
          ]}
          onChange={v => (v === 'accept' ? onAccept() : onDecline())}
          onCancel={onDecline}
        />
      </Box>
    </Dialog>
  )
}
