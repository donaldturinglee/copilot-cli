import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type CtrlOToExpandProps = {
  isExpanded?: boolean
  hiddenCount?: number
}

export function CtrlOToExpand({
  isExpanded = false,
  hiddenCount,
}: CtrlOToExpandProps): React.ReactNode {
  return (
    <Box marginLeft={2}>
      <ThemedText dimColor>
        {isExpanded
          ? 'Showing full transcript · Ctrl+O to collapse'
          : hiddenCount !== undefined && hiddenCount > 0
            ? `… ${hiddenCount} collapsed items · Ctrl+O to expand`
            : 'Ctrl+O to expand'}
      </ThemedText>
    </Box>
  )
}
