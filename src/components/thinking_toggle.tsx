import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type ThinkingToggleProps = {
  enabled: boolean
}

export function ThinkingToggle({
  enabled,
}: ThinkingToggleProps): React.ReactNode {
  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText color={enabled ? 'suggestion' : 'subtle'}>
        Thinking: {enabled ? 'ON' : 'OFF'}
      </ThemedText>
      <ThemedText dimColor>(Alt+T)</ThemedText>
    </Box>
  )
}
