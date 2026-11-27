import { useCallback } from 'react'
import type { Key } from '../../ink/events/keyboard_event.js'
import { useInput } from '../../ink/hooks/use_input.js'

export function useSelectInput(options: {
  value: string
  onChange: (next: string) => void
  onSubmit?: (value: string) => void
  isActive?: boolean
}): void {
  const { value, onChange, onSubmit, isActive = true } = options
  useInput(
    useCallback(
      (input: string, key: Key) => {
        if (key.return) {
          onSubmit?.(value)
          return
        }
        if (key.backspace) {
          onChange(value.slice(0, -1))
          return
        }
        if (!key.ctrl && !key.meta && !key.super && input.length > 0) {
          onChange(value + input)
        }
      },
      [value, onChange, onSubmit],
    ),
    { isActive },
  )
}
