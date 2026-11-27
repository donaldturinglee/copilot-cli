import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type ApproveApiKeyProps = {
  maskedKey: string
  onDecision: (approved: boolean) => void
}

export function ApproveApiKey({
  maskedKey,
  onDecision,
}: ApproveApiKeyProps): React.ReactNode {
  return (
    <Dialog
      title="Detected custom ANTHROPIC_API_KEY"
      subtitle={maskedKey}
      borderColor="warning"
      onCancel={() => onDecision(false)}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          Do you want to use this API key from your environment?
        </ThemedText>
        <Select<'yes' | 'no'>
          options={[
            { label: 'Yes, use this API key', value: 'yes' },
            { label: 'No, skip', value: 'no' },
          ]}
          onChange={v => onDecision(v === 'yes')}
          onCancel={() => onDecision(false)}
        />
      </Box>
    </Dialog>
  )
}
