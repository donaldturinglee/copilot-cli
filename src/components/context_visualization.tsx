import React from 'react'
import { Box } from '../ink/components/box.js'
import { Dialog } from './design_system/dialog.js'
import { ProgressBar } from './design_system/progress_bar.js'
import { ThemedText } from './design_system/themed_text.js'

export type ContextVisualizationProps = {
  usedTokens: number
  contextWindow: number
  messageCount: number
  toolCount: number
  onClose?: () => void
}

export function ContextVisualization({
  usedTokens,
  contextWindow,
  messageCount,
  toolCount,
  onClose,
}: ContextVisualizationProps): React.ReactNode {
  const ratio = contextWindow > 0 ? Math.min(1, usedTokens / contextWindow) : 0
  const pct = Math.round(ratio * 100)

  return (
    <Dialog
      title="Context Window Usage (/context)"
      subtitle="Esc to close"
      width={68}
      overlayId="context-viz"
      onCancel={onClose}
    >
      <Box flexDirection="column" gap={1}>
        <ProgressBar
          ratio={ratio}
          width={40}
          fillColor={pct >= 85 ? 'error' : pct >= 65 ? 'warning' : 'success'}
          showPercentage={true}
        />
        <ThemedText>
          {usedTokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens
        </ThemedText>
        <ThemedText dimColor>
          Messages in transcript: {messageCount} · Active tools: {toolCount}
        </ThemedText>
      </Box>
    </Dialog>
  )
}
