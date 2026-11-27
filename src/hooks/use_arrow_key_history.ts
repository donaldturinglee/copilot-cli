import { useCallback, useRef, useState } from 'react'
import type { PromptHistoryEntry } from '../history.js'

/**
 * Up/Down arrow prompt history traversal that preserves the user's in-progress
 * unsent draft when stepping back down to index -1.
 */
export function useArrowKeyHistory(
  entries: readonly PromptHistoryEntry[],
  getCurrentDraft: () => string,
  applyValue: (value: string) => void,
) {
  const [historyIndex, setHistoryIndex] = useState(-1)
  const savedDraftRef = useRef('')

  const navigatePrevious = useCallback(() => {
    if (entries.length === 0) return
    if (historyIndex === -1) {
      savedDraftRef.current = getCurrentDraft()
    }
    const nextIdx = Math.min(entries.length - 1, historyIndex + 1)
    setHistoryIndex(nextIdx)
    const entry = entries[nextIdx]
    if (entry) applyValue(entry.display)
  }, [entries, historyIndex, getCurrentDraft, applyValue])

  const navigateNext = useCallback(() => {
    if (historyIndex === -1) return
    if (historyIndex === 0) {
      setHistoryIndex(-1)
      applyValue(savedDraftRef.current)
      return
    }
    const nextIdx = historyIndex - 1
    setHistoryIndex(nextIdx)
    const entry = entries[nextIdx]
    if (entry) applyValue(entry.display)
  }, [entries, historyIndex, applyValue])

  const reset = useCallback(() => {
    setHistoryIndex(-1)
    savedDraftRef.current = ''
  }, [])

  return {
    historyIndex,
    navigatePrevious,
    navigateNext,
    reset,
  }
}
