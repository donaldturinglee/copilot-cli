import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type CostThresholdDialogProps = {
  currentCostUsd: number
  thresholdUsd: number
  onContinue: () => void
  onStop: () => void
}

export function CostThresholdDialog({
  currentCostUsd,
  thresholdUsd,
  onContinue,
  onStop,
}: CostThresholdDialogProps): React.ReactNode {
  return (
    <Dialog
      title="Session Cost Threshold Reached"
      borderColor="warning"
      overlayId="cost-threshold"
      onCancel={onStop}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          Current session spend (${currentCostUsd.toFixed(2)}) has reached your
          threshold of ${thresholdUsd.toFixed(2)}.
        </ThemedText>
        <Select
          options={[
            { label: 'Continue session', value: 'continue' },
            { label: 'Stop and exit', value: 'stop' },
          ]}
          onChange={val => (val === 'continue' ? onContinue() : onStop())}
        />
      </Box>
    </Dialog>
  )
}
