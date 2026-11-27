import React from 'react'
import { Box } from '../ink/components/box.js'
import { getTotalCost } from '../cost_tracker.js'
import { ThemedText } from './design_system/themed_text.js'

export type ExitFlowProps = {
  sessionId?: string
  turnCount?: number
}

export function ExitFlow({
  sessionId,
  turnCount = 0,
}: ExitFlowProps): React.ReactNode {
  const totalCost = getTotalCost()
  return (
    <Box flexDirection="column" paddingX={1}>
      <ThemedText dimColor>
        Session ended ({turnCount} turns, total cost ${totalCost.toFixed(4)}).
      </ThemedText>
      {sessionId ? (
        <ThemedText dimColor>
          Resume anytime with: copilot --resume {sessionId}
        </ThemedText>
      ) : null}
    </Box>
  )
}
