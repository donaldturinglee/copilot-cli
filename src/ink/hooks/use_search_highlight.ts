import { createContext, useContext } from 'react'
import type { SearchHighlightState } from '../search_highlight.js'

export type SearchHighlightContextValue = {
  state: SearchHighlightState
  setQuery: (query: string) => void
  nextMatch: () => void
  prevMatch: () => void
  clear: () => void
}

export const SearchHighlightContext =
  createContext<SearchHighlightContextValue>({
    state: { query: '', matches: [], activeIndex: 0 },
    setQuery: () => {},
    nextMatch: () => {},
    prevMatch: () => {},
    clear: () => {},
  })

export function useSearchHighlight(): SearchHighlightContextValue {
  return useContext(SearchHighlightContext)
}
