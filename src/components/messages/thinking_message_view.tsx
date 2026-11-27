import React, { memo } from 'react'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'

export type ThinkingMessageViewProps = {
  thinking: string
  verbose?: boolean
}

export const ThinkingMessageView = memo(function ThinkingMessageView({
  thinking,
  verbose = false,
}: ThinkingMessageViewProps): React.ReactNode {
  const trimmed = thinking.trim()
  if (!trimmed) return null

  if (!verbose) {
    const lines = trimmed.split('\n').length
    return (
      <Box marginLeft={2}>
        <ThemedText dimColor italic>
          ∴ Thinking ({lines} {lines === 1 ? 'line' : 'lines'} — Ctrl+O to
          expand)
        </ThemedText>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      <ThemedText dimColor italic bold>
        ∴ Thinking:
      </ThemedText>
      <ThemedText dimColor italic>
        {trimmed}
      </ThemedText>
    </Box>
  )
})
