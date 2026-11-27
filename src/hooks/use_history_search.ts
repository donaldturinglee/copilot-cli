import { useCallback, useMemo, useState } from 'react'
import { type PromptHistoryEntry, searchHistory } from '../history.js'

export function useHistorySearch(entries: readonly PromptHistoryEntry[]) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const matches = useMemo(
    () => searchHistory(query, entries),
    [query, entries],
  )

  const safeIndex =
    matches.length > 0 ? Math.min(selectedIndex, matches.length - 1) : 0

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return
    setSelectedIndex(prev => (prev + 1) % matches.length)
  }, [matches.length])

  const prevMatch = useCallback(() => {
    if (matches.length === 0) return
    setSelectedIndex(prev => (prev - 1 + matches.length) % matches.length)
  }, [matches.length])

  const updateQuery = useCallback((next: string) => {
    setQuery(next)
    setSelectedIndex(0)
  }, [])

  return {
    query,
    setQuery: updateQuery,
    matches,
    selectedIndex: safeIndex,
    selectedEntry: matches[safeIndex] ?? null,
    nextMatch,
    prevMatch,
  }
}
