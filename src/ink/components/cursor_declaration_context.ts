import { createContext } from 'react'
import type { CursorDeclaration } from '../cursor.js'

export type CursorDeclarationContextValue = {
  declareCursor: (decl: CursorDeclaration | null) => void
  currentCursor: CursorDeclaration | null
}

export const CursorDeclarationContext =
  createContext<CursorDeclarationContextValue>({
    declareCursor: () => {},
    currentCursor: null,
  })
