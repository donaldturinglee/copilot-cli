import React, { useMemo, useState } from 'react'
import { FIGURES } from '../../constants/figures.js'
import { useSearchInput } from '../../hooks/use_search_input.js'
import { Box } from '../../ink/components/box.js'
import { useInput } from '../../ink/hooks/use_input.js'
import { HighlightMatch } from '../../utilities/highlight_match.js'
import { ThemedBox } from './themed_box.js'
import { ThemedText } from './themed_text.js'

export type FuzzyPickerItem<T> = {
  id: string
  label: string
  description?: string
  value: T
}

export type FuzzyPickerProps<T> = {
  items: readonly FuzzyPickerItem<T>[]
  placeholder?: string
  maxVisible?: number
  onSelect: (item: FuzzyPickerItem<T>) => void
  onCancel?: () => void
  isActive?: boolean
}

function fuzzyScore(label: string, query: string): number {
  if (!query) return 1
  const hay = label.toLowerCase()
  const needle = query.toLowerCase()
  const idx = hay.indexOf(needle)
  if (idx !== -1) {
    return 100 - idx
  }
  let pos = 0
  let score = 0
  for (let i = 0; i < needle.length; i++) {
    const found = hay.indexOf(needle[i]!, pos)
    if (found === -1) return -1
    score += found === pos ? 4 : 1
    pos = found + 1
  }
  return score
}

export function FuzzyPicker<T>({
  items,
  placeholder = 'Type to filter…',
  maxVisible = 8,
  onSelect,
  onCancel,
  isActive = true,
}: FuzzyPickerProps<T>): React.ReactNode {
  const [focusedIdx, setFocusedIdx] = useState(0)

  const search = useSearchInput({
    isActive,
    onChange: () => setFocusedIdx(0),
    onCancel,
  })

  const filtered = useMemo(() => {
    const scored: { item: FuzzyPickerItem<T>; score: number }[] = []
    for (const item of items) {
      const s = fuzzyScore(item.label, search.query)
      if (s >= 0) scored.push({ item, score: s })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.map(e => e.item)
  }, [items, search.query])

  const clampedIdx =
    filtered.length === 0 ? 0 : Math.min(focusedIdx, filtered.length - 1)

  useInput(
    (_input, key) => {
      if (key.upArrow || (key.ctrl && key.name === 'p')) {
        setFocusedIdx(i =>
          filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
        )
        return
      }
      if (key.downArrow || (key.ctrl && key.name === 'n')) {
        setFocusedIdx(i =>
          filtered.length === 0 ? 0 : (i + 1) % filtered.length,
        )
        return
      }
      if (key.return) {
        const picked = filtered[clampedIdx]
        if (picked) onSelect(picked)
      }
    },
    { isActive },
  )

  const windowStart = Math.max(
    0,
    Math.min(
      clampedIdx - Math.floor(maxVisible / 2),
      Math.max(0, filtered.length - maxVisible),
    ),
  )
  const visible = filtered.slice(windowStart, windowStart + maxVisible)

  return (
    <ThemedBox flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <ThemedText color="suggestion">{FIGURES.pointer}</ThemedText>
        {search.query.length > 0 ? (
          <ThemedText>{search.query}</ThemedText>
        ) : (
          <ThemedText dimColor>{placeholder}</ThemedText>
        )}
      </Box>
      <Box flexDirection="column">
        {visible.length === 0 ? (
          <ThemedText dimColor>No matches</ThemedText>
        ) : (
          visible.map((item, i) => {
            const absIdx = windowStart + i
            const isFocused = absIdx === clampedIdx
            return (
              <Box key={item.id} flexDirection="row" gap={1}>
                <ThemedText color={isFocused ? 'suggestion' : 'inactive'}>
                  {isFocused ? FIGURES.pointer : ' '}
                </ThemedText>
                <HighlightMatch
                  text={item.label}
                  query={search.query}
                  baseColor={isFocused ? 'suggestion' : 'text'}
                />
                {item.description ? (
                  <ThemedText dimColor>— {item.description}</ThemedText>
                ) : null}
              </Box>
            )
          })
        )}
      </Box>
    </ThemedBox>
  )
}
