import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type BypassPermissionsModeDialogProps = {
  onAccept: () => void
  onDecline: () => void
}

export function BypassPermissionsModeDialog({
  onAccept,
  onDecline,
}: BypassPermissionsModeDialogProps): React.ReactNode {
  return (
    <Dialog
      title="WARNING: Bypass Permissions Mode"
      borderColor="error"
      onCancel={onDecline}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color="error">
          In Bypass Permissions mode, tools execute without interactive
          confirmation (explicit deny rules and sensitive-path safety checks
          remain enforced).
        </ThemedText>
        <Select<'decline' | 'accept'>
          options={[
            { label: 'No, exit safely', value: 'decline' },
            { label: 'Yes, I accept the risks', value: 'accept' },
          ]}
          onChange={v => (v === 'accept' ? onAccept() : onDecline())}
          onCancel={onDecline}
        />
      </Box>
    </Dialog>
  )
}
