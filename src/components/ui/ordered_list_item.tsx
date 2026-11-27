import React from 'react'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'

export type OrderedListItemProps = {
  marker?: string
  children: React.ReactNode
}

export function OrderedListItem({
  marker = '1.',
  children,
}: OrderedListItemProps): React.ReactNode {
  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText dimColor>{marker}</ThemedText>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}
