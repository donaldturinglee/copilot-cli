import React, { createContext, useContext } from 'react'
import {
  DEFAULT_TERMINAL_COLUMNS,
  DEFAULT_TERMINAL_ROWS,
} from '../constants.js'

export type TerminalSize = {
  columns: number
  rows: number
}

export const TerminalSizeContext = createContext<TerminalSize | null>(null)

export function TerminalSizeProvider({
  columns,
  rows,
  children,
}: TerminalSize & { children: React.ReactNode }): React.ReactNode {
  return (
    <TerminalSizeContext.Provider value={{ columns, rows }}>
      {children}
    </TerminalSizeContext.Provider>
  )
}

export function useTerminalSizeContext(): TerminalSize {
  return (
    useContext(TerminalSizeContext) ?? {
      columns: DEFAULT_TERMINAL_COLUMNS,
      rows: DEFAULT_TERMINAL_ROWS,
    }
  )
}
