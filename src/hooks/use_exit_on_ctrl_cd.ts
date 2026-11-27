import { useCallback, useState } from 'react'
import type { Key } from '../ink/events/keyboard_event.js'
import { useApp } from '../ink/hooks/use_app.js'
import { useInput } from '../ink/hooks/use_input.js'
import { DOUBLE_PRESS_TIMEOUT_MS, useDoublePress } from './use_double_press.js'

export type ExitPromptState = {
  pending: boolean
  keyName: 'ctrl+c' | 'ctrl+d' | null
}

export function useExitOnCtrlCD(options?: {
  isActive?: boolean
  onExit?: () => void
  timeoutMs?: number
}): ExitPromptState {
  const { exit } = useApp()
  const [keyName, setKeyName] = useState<'ctrl+c' | 'ctrl+d' | null>(null)
  const doExit = useCallback(() => {
    if (options?.onExit) options.onExit()
    else exit()
  }, [options?.onExit, exit])

  const doublePress = useDoublePress(
    doExit,
    undefined,
    options?.timeoutMs ?? DOUBLE_PRESS_TIMEOUT_MS,
  )

  useInput(
    useCallback(
      (input: string, key: Key) => {
        if (key.ctrl && input === 'c') {
          setKeyName('ctrl+c')
          doublePress.trigger()
        } else if (key.ctrl && input === 'd') {
          setKeyName('ctrl+d')
          doublePress.trigger()
        }
      },
      [doublePress],
    ),
    { isActive: options?.isActive ?? true },
  )

  return {
    pending: doublePress.pending,
    keyName: doublePress.pending ? keyName : null,
  }
}
