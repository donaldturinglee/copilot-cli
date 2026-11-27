import React from 'react'
import { Box } from '../ink/components/box.js'
import { Divider } from './design_system/divider.js'
import { ThemedText } from './design_system/themed_text.js'

export type CompactSummaryProps = {
  messagesSummarized?: number
  preTokens?: number
  summaryText?: string
  width?: number
}

export function CompactSummary({
  messagesSummarized,
  preTokens,
  summaryText,
  width = 60,
}: CompactSummaryProps): React.ReactNode {
  const meta: string[] = []
  if (messagesSummarized !== undefined) {
    meta.push(`${messagesSummarized} messages compacted`)
  }
  if (preTokens !== undefined) {
    meta.push(`${preTokens.toLocaleString()} tokens before`)
  }
  return (
    <Box flexDirection="column" marginY={0}>
      <Divider
        width={width}
        title={meta.length > 0 ? `Compacted · ${meta.join(', ')}` : 'Conversation Compacted'}
      />
      {summaryText ? <ThemedText dimColor>{summaryText}</ThemedText> : null}
    </Box>
  )
}
