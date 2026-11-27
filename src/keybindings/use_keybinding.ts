import { useCallback, useEffect, useRef } from 'react'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { useInput } from '../ink/hooks/use_input.js'
import {
  useOptionalKeybindingContext,
  useRegisterKeybindingContext,
} from './keybinding_context.js'
import type { KeybindingContextName } from './types.js'

export type UseKeybindingOptions = {
  context: KeybindingContextName
  isActive?: boolean
}

/**
 * Bind a semantic keybinding action (including multi-keystroke chords) within a
 * specific UI context.
 */
export function useKeybinding(
  action: string,
  handler: () => void,
  options: UseKeybindingOptions,
): void {
  const { context, isActive = true } = options
  const ctx = useOptionalKeybindingContext()
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useRegisterKeybindingContext(context, isActive)

  useEffect(() => {
    if (!ctx || !isActive) return
    return ctx.registerHandler({
      action,
      context,
      handler: () => handlerRef.current(),
    })
  }, [ctx, action, context, isActive])

  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if (!ctx || !isActive || event.immediatePropagationStopped) return
        const contexts: KeybindingContextName[] =
          context === 'Global' ? ['Global'] : [context, 'Global']
        const result = ctx.resolve(input, key, contexts)
        if (result.type === 'match' && result.action === action) {
          handlerRef.current()
          event.stopImmediatePropagation()
        }
      },
      [ctx, action, context, isActive],
    ),
    { isActive },
  )
}

export function useKeybindings(
  actionHandlers: Record<string, () => void>,
  options: UseKeybindingOptions,
): void {
  const { context, isActive = true } = options
  const ctx = useOptionalKeybindingContext()
  const handlersRef = useRef(actionHandlers)
  handlersRef.current = actionHandlers

  useRegisterKeybindingContext(context, isActive)

  useEffect(() => {
    if (!ctx || !isActive) return
    const unsubs: (() => void)[] = []
    for (const action of Object.keys(actionHandlers)) {
      unsubs.push(
        ctx.registerHandler({
          action,
          context,
          handler: () => handlersRef.current[action]?.(),
        }),
      )
    }
    return () => {
      for (const u of unsubs) u()
    }
  }, [ctx, context, isActive, Object.keys(actionHandlers).join('|')])

  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if (!ctx || !isActive || event.immediatePropagationStopped) return
        const contexts: KeybindingContextName[] =
          context === 'Global' ? ['Global'] : [context, 'Global']
        const result = ctx.resolve(input, key, contexts)
        if (result.type === 'match') {
          const fn = handlersRef.current[result.action]
          if (fn) {
            fn()
            event.stopImmediatePropagation()
          }
        }
      },
      [ctx, context, isActive],
    ),
    { isActive },
  )
}
