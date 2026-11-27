import React from 'react'
import { Box } from '../../ink/components/box.js'
import type { ColorValue } from '../../ink/styles.js'
import { ThemedText } from './themed_text.js'

const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

export type ProgressBarProps = {
  /** Normalized progress ratio in `[0, 1]`. */
  ratio: number
  width?: number
  fillColor?: ColorValue
  emptyColor?: ColorValue
  showPercentage?: boolean
}

export function ProgressBar({
  ratio,
  width = 24,
  fillColor = 'rate_limit_fill',
  emptyColor = 'rate_limit_empty',
  showPercentage = false,
}: ProgressBarProps): React.ReactNode {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const safeW = Math.max(1, Math.floor(width))
  const exactCells = clamped * safeW
  const fullCells = Math.floor(exactCells)
  const partialIdx = Math.round((exactCells - fullCells) * 8)

  let filled = '█'.repeat(fullCells)
  let remaining = safeW - fullCells
  if (partialIdx > 0 && remaining > 0) {
    filled += BLOCKS[Math.min(8, partialIdx)]!
    remaining--
  }
  const empty = '░'.repeat(Math.max(0, remaining))
  const pct = `${Math.round(clamped * 100)}%`

  return (
    <Box flexDirection="row" gap={1}>
      <Box flexDirection="row">
        <ThemedText color={fillColor}>{filled}</ThemedText>
        <ThemedText color={emptyColor}>{empty}</ThemedText>
      </Box>
      {showPercentage ? <ThemedText dimColor>{pct}</ThemedText> : null}
    </Box>
  )
}
