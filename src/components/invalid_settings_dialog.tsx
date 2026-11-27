import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import {
  type ValidationErrorItem,
  ValidationErrorsList,
} from './validation_errors_list.js'

export type InvalidSettingsDialogProps = {
  errors: readonly ValidationErrorItem[]
  onContinue: () => void
  onExit: () => void
}

export function InvalidSettingsDialog({
  errors,
  onContinue,
  onExit,
}: InvalidSettingsDialogProps): React.ReactNode {
  return (
    <Dialog
      title="Settings Validation Issues"
      borderColor="warning"
      onCancel={onExit}
    >
      <Box flexDirection="column" gap={1}>
        <ValidationErrorsList errors={errors} />
        <Select<'continue' | 'exit'>
          options={[
            { label: 'Continue with invalid entries ignored', value: 'continue' },
            { label: 'Exit to fix settings.json', value: 'exit' },
          ]}
          onChange={v => (v === 'continue' ? onContinue() : onExit())}
          onCancel={onExit}
        />
      </Box>
    </Dialog>
  )
}
