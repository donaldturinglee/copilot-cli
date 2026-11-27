import React, { useCallback } from 'react'
import type { PromptHistoryEntry } from '../history.js'
import { useHistorySearch } from '../hooks/use_history_search.js'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { Box } from '../ink/components/box.js'
import { useInput } from '../ink/hooks/use_input.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type HistorySearchDialogProps = {
  entries: readonly PromptHistoryEntry[]
  onAccept: (display: string, executeImmediately: boolean) => void
  onCancel: () => void
}

/**
 * `Ctrl+R` reverse incremental search dialog over `~/.copilot/history.jsonl`.
 */
export function HistorySearchDialog({
  entries,
  onAccept,
  onCancel,
}: HistorySearchDialogProps): React.ReactNode {
  const { query, setQuery, matches, selectedIndex, selectedEntry, nextMatch, prevMatch } =
    useHistorySearch(entries)

  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if (event.immediatePropagationStopped) return
        if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
          onCancel()
          event.stopImmediatePropagation()
          return
        }
        if (key.ctrl && input.toLowerCase() === 'r') {
          nextMatch()
          event.stopImmediatePropagation()
          return
        }
        if (key.downArrow) {
          nextMatch()
          event.stopImmediatePropagation()
          return
        }
        if (key.upArrow) {
          prevMatch()
          event.stopImmediatePropagation()
          return
        }
        if (key.tab) {
          if (selectedEntry) onAccept(selectedEntry.display, false)
          else onCancel()
          event.stopImmediatePropagation()
          return
        }
        if (key.return) {
          if (selectedEntry) onAccept(selectedEntry.display, true)
          else onCancel()
          event.stopImmediatePropagation()
          return
        }
        if (key.backspace) {
          setQuery(query.slice(0, -1))
          event.stopImmediatePropagation()
          return
        }
        if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) {
          setQuery(query + input)
          event.stopImmediatePropagation()
        }
      },
      [query, setQuery, nextMatch, prevMatch, selectedEntry, onAccept, onCancel],
    ),
  )

  return (
    <Dialog
      title="History Search (Ctrl+R)"
      subtitle="Enter to run · Tab to edit · Ctrl+R next · Esc cancel"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <ThemedText color="suggestion" bold>
            Search:
          </ThemedText>
          <ThemedText>{query || '(type to filter)'}</ThemedText>
          <ThemedText dimColor>({matches.length} matches)</ThemedText>
        </Box>
        {matches.length === 0 ? (
          <ThemedText dimColor>No matching history entries.</ThemedText>
        ) : (
          <Box flexDirection="column">
            {matches.slice(0, 8).map((entry, idx) => {
              const isSelected = idx === selectedIndex
              return (
                <Box key={`${entry.timestamp}-${idx}`} flexDirection="row" gap={1}>
                  <ThemedText color={isSelected ? 'claude' : 'subtle'}>
                    {isSelected ? '❯' : ' '}
                  </ThemedText>
                  <ThemedText
                    color={isSelected ? 'claude' : 'text'}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    {entry.display.replace(/\n/g, ' ↵ ')}
                  </ThemedText>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    </Dialog>
  )
}
