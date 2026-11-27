import { useCallback } from 'react'
import type { Key } from '../../ink/events/keyboard_event.js'
import { useInput } from '../../ink/hooks/use_input.js'

export type SelectNavigationCallbacks = {
  onNext: () => void
  onPrevious: () => void
  onAccept: () => void
  onToggle?: () => void
  onCancel?: () => void
  isDisabled?: boolean
}

export function useSelectNavigation({
  onNext,
  onPrevious,
  onAccept,
  onToggle,
  onCancel,
  isDisabled = false,
}: SelectNavigationCallbacks): void {
  useInput(
    useCallback(
      (input: string, key: Key) => {
        if (key.downArrow || (key.ctrl && input === 'n') || input === 'j') {
          onNext()
          return
        }
        if (key.upArrow || (key.ctrl && input === 'p') || input === 'k') {
          onPrevious()
          return
        }
        if (input === ' ' && onToggle) {
          onToggle()
          return
        }
        if (key.return) {
          onAccept()
          return
        }
        if (key.escape && onCancel) {
          onCancel()
        }
      },
      [onNext, onPrevious, onAccept, onToggle, onCancel],
    ),
    { isActive: !isDisabled },
  )
}
