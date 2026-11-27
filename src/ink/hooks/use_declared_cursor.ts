import { useContext, useEffect } from 'react'
import { CursorDeclarationContext } from '../components/cursor_declaration_context.js'
import type { CursorDeclaration } from '../cursor.js'

export function useDeclaredCursor(declaration: CursorDeclaration | null): void {
  const { declareCursor } = useContext(CursorDeclarationContext)

  useEffect(() => {
    declareCursor(declaration)
    return () => {
      declareCursor(null)
    }
  }, [
    declareCursor,
    declaration?.x,
    declaration?.y,
    declaration?.visible,
    declaration?.shape,
  ])
}
