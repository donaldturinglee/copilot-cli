import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedBox } from './design_system/themed_box.js'
import { ThemedText } from './design_system/themed_text.js'

export type SearchBoxProps = {
  query: string
  placeholder?: string
  matchCount?: number
  activeMatchIndex?: number
  isFocused?: boolean
}

export function SearchBox({
  query,
  placeholder = 'Search…',
  matchCount,
  activeMatchIndex = 0,
  isFocused = true,
}: SearchBoxProps): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="row"
      justifyContent="space-between"
      borderStyle="round"
      borderColor={isFocused ? 'suggestion' : 'promptBorder'}
      paddingX={1}
    >
      <Box flexDirection="row" gap={1}>
        <ThemedText color="suggestion">/</ThemedText>
        {query.length > 0 ? (
          <ThemedText>{query}</ThemedText>
        ) : (
          <ThemedText dimColor>{placeholder}</ThemedText>
        )}
      </Box>
      {matchCount !== undefined ? (
        <ThemedText dimColor>
          {matchCount === 0
            ? '0 matches'
            : `${Math.min(activeMatchIndex + 1, matchCount)}/${matchCount}`}
        </ThemedText>
      ) : null}
    </ThemedBox>
  )
}
