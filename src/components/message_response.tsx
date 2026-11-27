import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type MessageResponseProps = {
  height?: number
  children: React.ReactNode
}

/**
 * Standard tool/assistant response wrapper prefixed with the `⎿` tree connector.
 */
export function MessageResponse({
  height,
  children,
}: MessageResponseProps): React.ReactNode {
  return (
    <Box flexDirection="row" height={height} overflowY="hidden">
      <ThemedText dimColor>{'  ⎿  '}</ThemedText>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}
