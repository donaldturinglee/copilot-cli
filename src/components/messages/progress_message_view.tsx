import React, { memo } from 'react'
import { Box } from '../../ink/components/box.js'
import type { ProgressMessage } from '../../types/message.js'
import { BashModeProgress } from '../bash_mode_progress.js'
import { ThemedText } from '../design_system/themed_text.js'

export type ProgressMessageViewProps = {
  message: ProgressMessage
}

export const ProgressMessageView = memo(function ProgressMessageView({
  message,
}: ProgressMessageViewProps): React.ReactNode {
  const data = message.data
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>

  if (record.type === 'bash_progress') {
    const command =
      typeof record.command === 'string' ? record.command : 'shell'
    const output = typeof record.output === 'string' ? record.output : ''
    const elapsedSeconds =
      typeof record.elapsedTimeSeconds === 'number'
        ? record.elapsedTimeSeconds
        : undefined
    return (
      <BashModeProgress
        command={command}
        outputLines={output ? output.split('\n') : []}
        elapsedSec={elapsedSeconds}
      />
    )
  }

  const label =
    typeof record.message === 'string'
      ? record.message
      : typeof record.type === 'string'
        ? record.type
        : 'Running…'

  return (
    <Box marginLeft={2}>
      <ThemedText dimColor>⋯ {label}</ThemedText>
    </Box>
  )
})
