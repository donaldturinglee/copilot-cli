import React, { createContext, useContext, useEffect, useState } from 'react'
import {
  getTerminalFocused,
  subscribeTerminalFocus,
} from '../terminal_focus_state.js'

export const TerminalFocusContext = createContext<boolean>(true)

export function TerminalFocusProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [focused, setFocused] = useState<boolean>(() => getTerminalFocused())

  useEffect(() => {
    return subscribeTerminalFocus(setFocused)
  }, [])

  return (
    <TerminalFocusContext.Provider value={focused}>
      {children}
    </TerminalFocusContext.Provider>
  )
}

export function useTerminalFocusContext(): boolean {
  return useContext(TerminalFocusContext)
}
