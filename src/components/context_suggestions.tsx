import React from 'react'
import { Box } from '../ink/components/box.js'
import type { ContextSuggestion } from '../utilities/context_suggestions.js'
import { ThemedText } from './design_system/themed_text.js'

export type ContextSuggestionsProps = {
  suggestions: readonly ContextSuggestion[]
  selectedIndex?: number
}

export function ContextSuggestions({
  suggestions,
  selectedIndex = -1,
}: ContextSuggestionsProps): React.ReactNode {
  if (suggestions.length === 0) return null
  return (
    <Box flexDirection="row" gap={2} paddingX={1}>
      {suggestions.slice(0, 3).map((s, idx) => (
        <ThemedText
          key={s.id}
          color={idx === selectedIndex ? 'suggestion' : 'subtle'}
          bold={idx === selectedIndex}
        >
          [{idx + 1}] {s.label}
        </ThemedText>
      ))}
    </Box>
  )
}
