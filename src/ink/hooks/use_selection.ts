import { createContext, useContext } from 'react'
import {
  createSelectionState,
  type SelectionState,
} from '../selection.js'

export type SelectionContextValue = {
  selection: SelectionState
  hasSelection: boolean
  getSelectedText: () => string
  clearSelection: () => void
}

export const SelectionContext = createContext<SelectionContextValue>({
  selection: createSelectionState(),
  hasSelection: false,
  getSelectedText: () => '',
  clearSelection: () => {},
})

export function useSelection(): SelectionContextValue {
  return useContext(SelectionContext)
}
