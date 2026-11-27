import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type IdleReturnDialogProps = {
  idleMinutes: number
  onResume: () => void
  onCompact: () => void
}

export function IdleReturnDialog({
  idleMinutes,
  onResume,
  onCompact,
}: IdleReturnDialogProps): React.ReactNode {
  return (
    <Dialog
      title="Welcome Back"
      subtitle={`Session was idle for ${idleMinutes} minutes`}
      overlayId="idle-return"
      onCancel={onResume}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText dimColor>
          Would you like to continue right where you left off or compact older
          context?
        </ThemedText>
        <Select
          options={[
            { label: 'Resume session', value: 'resume' },
            { label: 'Compact context first (/compact)', value: 'compact' },
          ]}
          onChange={val => (val === 'compact' ? onCompact() : onResume())}
        />
      </Box>
    </Dialog>
  )
}
