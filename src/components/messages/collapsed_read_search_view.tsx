import React, { memo } from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import {
  type CollapsedReadSearchGroup,
  formatCollapsedReadSearchSummary,
} from '../../utilities/collapse_read_search.js'
import { ThemedText } from '../design_system/themed_text.js'

export type CollapsedReadSearchViewProps = {
  group: CollapsedReadSearchGroup
}

export const CollapsedReadSearchView = memo(function CollapsedReadSearchView({
  group,
}: CollapsedReadSearchViewProps): React.ReactNode {
  const summary = formatCollapsedReadSearchSummary(group)
  return (
    <Box flexDirection="row" gap={1} marginTop={1}>
      <ThemedText color="success">{BLACK_CIRCLE}</ThemedText>
      <ThemedText dimColor>
        {summary} (Ctrl+O to expand)
      </ThemedText>
    </Box>
  )
})
