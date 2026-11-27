import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type InterruptedByUserProps = {
  reason?: string
}

export function InterruptedByUser({
  reason = 'Interrupted · What should Copilot do instead?',
}: InterruptedByUserProps): React.ReactNode {
  return (
    <Box paddingLeft={2}>
      <ThemedText color="error">{reason}</ThemedText>
    </Box>
  )
}
