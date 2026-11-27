import React from 'react'
import { FIGURES } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type TokenWarningProps = {
  usedTokens: number
  contextWindow: number
  warningThreshold?: number
}

export function TokenWarning({
  usedTokens,
  contextWindow,
  warningThreshold = 0.8,
}: TokenWarningProps): React.ReactNode {
  if (contextWindow <= 0) return null
  const ratio = usedTokens / contextWindow
  if (ratio < warningThreshold) return null

  const pct = Math.min(100, Math.round(ratio * 100))
  const isCritical = ratio >= 0.95

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <ThemedText color={isCritical ? 'error' : 'warning'}>
        {FIGURES.warning} Context {pct}% full ({usedTokens.toLocaleString()}/
        {contextWindow.toLocaleString()} tokens) — run /compact to free space
      </ThemedText>
    </Box>
  )
}
