import { useCallback, useState } from 'react'
import type { Key } from '../ink/events/keyboard_event.js'
import { useInput } from '../ink/hooks/use_input.js'
import { Cursor } from '../utilities/cursor.js'

export type UseSearchInputOptions = {
  isActive?: boolean
  initialQuery?: string
  onChange?: (query: string) => void
  onSubmit?: (query: string) => void
  onCancel?: () => void
}

export type UseSearchInputResult = {
  query: string
  cursorOffset: number
  setQuery: (value: string) => void
  clear: () => void
}

/**
 * Interactive search box input hook backed by grapheme-aware `Cursor`.
 */
export function useSearchInput(
  options: UseSearchInputOptions = {},
): UseSearchInputResult {
  const { isActive = true, initialQuery = '', onChange, onSubmit, onCancel } =
    options
  const [cursor, setCursor] = useState<Cursor>(() =>
    Cursor.fromText(initialQuery),
  )

  const applyCursor = useCallback(
    (next: Cursor) => {
      setCursor(next)
      if (next.text !== cursor.text) {
        onChange?.(next.text)
      }
    },
    [cursor.text, onChange],
  )

  const setQuery = useCallback(
    (value: string) => {
      const next = Cursor.fromText(value)
      setCursor(next)
      onChange?.(value)
    },
    [onChange],
  )

  const clear = useCallback(() => {
    setQuery('')
  }, [setQuery])

  useInput(
    useCallback(
      (input: string, key: Key) => {
        if (key.escape) {
          onCancel?.()
          return
        }
        if (key.return) {
          onSubmit?.(cursor.text)
          return
        }
        if (key.leftArrow) {
          applyCursor(cursor.left())
          return
        }
        if (key.rightArrow) {
          applyCursor(cursor.right())
          return
        }
        if (key.home || (key.ctrl && input === 'a')) {
          applyCursor(cursor.startOfLine())
          return
        }
        if (key.end || (key.ctrl && input === 'e')) {
          applyCursor(cursor.endOfLine())
          return
        }
        if (key.ctrl && input === 'u') {
          applyCursor(cursor.deleteToLineStart())
          return
        }
        if (key.ctrl && input === 'w') {
          applyCursor(cursor.deleteWordBefore())
          return
        }
        if (key.backspace) {
          applyCursor(cursor.backspace())
          return
        }
        if (key.delete) {
          applyCursor(cursor.del())
          return
        }
        if (!key.ctrl && !key.meta && !key.super && input.length > 0) {
          applyCursor(cursor.insert(input))
        }
      },
      [cursor, applyCursor, onCancel, onSubmit],
    ),
    { isActive },
  )

  return {
    query: cursor.text,
    cursorOffset: cursor.offset,
    setQuery,
    clear,
  }
}
