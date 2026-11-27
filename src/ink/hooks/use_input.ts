import { useEffect, useRef } from 'react'
import type { InputEvent } from '../events/input_event.js'
import type { Key } from '../events/keyboard_event.js'
import { useStdin } from './use_stdin.js'

export type InputHandler = (
  input: string,
  key: Key,
  event: InputEvent,
) => void

export type UseInputOptions = {
  isActive?: boolean
}

/**
 * Subscribe to keyboard and wheel input events from Ink's StdinContext.
 * Supports `event.stopImmediatePropagation()` for chord interception.
 */
export function useInput(
  inputHandler: InputHandler,
  options: UseInputOptions = {},
): void {
  const { isActive = true } = options
  const stdinContext = useStdin()
  const handlerRef = useRef(inputHandler)
  handlerRef.current = inputHandler

  useEffect(() => {
    if (!isActive || !stdinContext) return
    const unsubscribe = stdinContext.internal_eventEmitter.on(
      'input',
      event => {
        if (event.immediatePropagationStopped) return
        handlerRef.current(event.input, event.key, event)
      },
    )
    return unsubscribe
  }, [isActive, stdinContext])
}
