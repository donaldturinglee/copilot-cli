import React from 'react'
import { Box } from '../ink/components/box.js'
import type { SessionStatsSummary } from '../utilities/stats.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type StatsProps = {
  stats: SessionStatsSummary
  onClose?: () => void
}

export function Stats({ stats, onClose }: StatsProps): React.ReactNode {
  return (
    <Dialog
      title="Session Statistics (/stats)"
      subtitle="Esc to close"
      width={66}
      overlayId="stats-dialog"
      onCancel={onClose}
    >
      <Box flexDirection="column" gap={0}>
        <ThemedText>
          Turns: {stats.userTurns} user / {stats.assistantTurns} assistant (
          {stats.toolCalls} tool calls)
        </ThemedText>
        <ThemedText>
          Tokens: {stats.inputTokens.toLocaleString()} in ·{' '}
          {stats.outputTokens.toLocaleString()} out
        </ThemedText>
        <ThemedText>
          Estimated cost: ${stats.totalCostUsd.toFixed(4)}
        </ThemedText>
        <ThemedText dimColor>
          Code changes: +{stats.linesAdded} / -{stats.linesRemoved} lines
        </ThemedText>
      </Box>
    </Dialog>
  )
}
