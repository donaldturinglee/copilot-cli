import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type InvalidConfigDialogProps = {
  filePath: string
  errorMessage: string
  onAction: (action: 'reset' | 'exit') => void
}

export function InvalidConfigDialog({
  filePath,
  errorMessage,
  onAction,
}: InvalidConfigDialogProps): React.ReactNode {
  return (
    <Dialog
      title="Invalid Configuration File"
      subtitle={filePath}
      borderColor="error"
      onCancel={() => onAction('exit')}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color="error">{errorMessage}</ThemedText>
        <Select<'exit' | 'reset'>
          options={[
            { label: 'Exit so I can fix the file manually', value: 'exit' },
            { label: 'Back up and reset configuration', value: 'reset' },
          ]}
          onChange={onAction}
          onCancel={() => onAction('exit')}
        />
      </Box>
    </Dialog>
  )
}
