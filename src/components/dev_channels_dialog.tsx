/**
 * Confirmation warning dialog when `--dangerously-load-development-channels`
 * is active.
 */

import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export interface DevChannelsDialogProps {
  channelNames: readonly string[]
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Prompts user confirmation before loading unverified development MCP channels.
 */
export function DevChannelsDialog({
  channelNames,
  onConfirm,
  onCancel,
}: DevChannelsDialogProps): React.ReactNode {
  return (
    <Dialog
      title="Development MCP Channels Warning"
      borderColor="warning"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color="warning">
          Development channels bypass official marketplace allowlist checks:{' '}
          {channelNames.join(', ')}
        </ThemedText>
        <Select
          options={[
            { label: 'Accept risk and load development channels', value: 'yes' },
            { label: 'Cancel', value: 'no' },
          ]}
          onChange={val => (val === 'yes' ? onConfirm() : onCancel())}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
