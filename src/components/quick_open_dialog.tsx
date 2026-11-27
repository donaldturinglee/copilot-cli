import React, { useMemo, useState } from 'react'
import { Box } from '../ink/components/box.js'
import type { FileSuggestionEngine } from '../utilities/suggestions/file_suggestions.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'
import { TextInput } from './text_input.js'

export type QuickOpenDialogProps = {
  fileEngine: FileSuggestionEngine
  onSelectFile: (filePath: string) => void
  onCancel: () => void
}

/**
 * `Ctrl+Shift+P` sub-millisecond fuzzy file quick-open backed by `FileIndex`.
 */
export function QuickOpenDialog({
  fileEngine,
  onSelectFile,
  onCancel,
}: QuickOpenDialogProps): React.ReactNode {
  const [query, setQuery] = useState('')
  const results = useMemo(
    () => fileEngine.search(query, { limit: 10 }),
    [fileEngine, query],
  )

  return (
    <Dialog
      title="Quick Open File"
      subtitle="Enter to insert @file reference · Esc to close"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <ThemedText color="suggestion" bold>
            @
          </ThemedText>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              const first = results[0]
              if (first) {
                onSelectFile(first.displayText.replace(/^@/, ''))
              } else {
                onCancel()
              }
            }}
            placeholder="Type file path…"
          />
        </Box>
        {results.length === 0 ? (
          <ThemedText dimColor>No matching files.</ThemedText>
        ) : (
          <Box flexDirection="column">
            {results.map((item, idx) => (
              <ThemedText
                key={item.id}
                color={idx === 0 ? 'claude' : 'text'}
                bold={idx === 0}
              >
                {idx === 0 ? '❯ ' : '  '}
                {item.displayText}
              </ThemedText>
            ))}
          </Box>
        )}
      </Box>
    </Dialog>
  )
}
