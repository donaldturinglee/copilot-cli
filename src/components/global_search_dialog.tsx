import React, { useMemo, useState } from 'react'
import { Box } from '../ink/components/box.js'
import type { Message } from '../types/message.js'
import {
  extractMessageSearchText,
  findTranscriptMatches,
} from '../utilities/transcript_search.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'
import { TextInput } from './text_input.js'

export type GlobalSearchDialogProps = {
  messages: readonly Message[]
  onSelectMessageIndex: (index: number) => void
  onCancel: () => void
}

/**
 * `Ctrl+Shift+F` / `/` transcript incremental search dialog.
 */
export function GlobalSearchDialog({
  messages,
  onSelectMessageIndex,
  onCancel,
}: GlobalSearchDialogProps): React.ReactNode {
  const [query, setQuery] = useState('')
  const matchIndices = useMemo(
    () => findTranscriptMatches(messages, query),
    [messages, query],
  )

  return (
    <Dialog
      title="Search Transcript"
      subtitle="Enter to jump to first match · Esc to close"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <ThemedText color="suggestion" bold>
            /
          </ThemedText>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              if (matchIndices.length > 0) {
                onSelectMessageIndex(matchIndices[0]!)
              } else {
                onCancel()
              }
            }}
            placeholder="Search messages…"
          />
        </Box>
        <ThemedText dimColor>
          {query.trim()
            ? `${matchIndices.length} matching messages`
            : `Searching across ${messages.length} messages`}
        </ThemedText>
        <Box flexDirection="column">
          {matchIndices.slice(0, 6).map(idx => {
            const snippet = extractMessageSearchText(messages[idx]!)
              .replace(/\s+/g, ' ')
              .slice(0, 72)
            return (
              <ThemedText key={idx} dimColor wrap="truncate-end">
                #{idx + 1}: {snippet}
              </ThemedText>
            )
          })}
        </Box>
      </Box>
    </Dialog>
  )
}
