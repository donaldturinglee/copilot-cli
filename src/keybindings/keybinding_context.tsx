import React, {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
} from 'react'
import type { Key } from '../ink/events/keyboard_event.js'
import {
  type ChordResolveResult,
  getBindingDisplayText,
  resolveKeyWithChordState,
} from './resolver.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

export type HandlerRegistration = {
  action: string
  context: KeybindingContextName
  handler: () => void
}

export type KeybindingContextValue = {
  resolve: (
    input: string,
    key: Key,
    activeContexts: KeybindingContextName[],
  ) => ChordResolveResult
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  getDisplayText: (
    action: string,
    context: KeybindingContextName,
  ) => string | undefined
  bindings: ParsedBinding[]
  pendingChord: ParsedKeystroke[] | null
  activeContexts: Set<KeybindingContextName>
  registerActiveContext: (context: KeybindingContextName) => void
  unregisterActiveContext: (context: KeybindingContextName) => void
  registerHandler: (registration: HandlerRegistration) => () => void
  invokeAction: (action: string) => boolean
}

const KeybindingContext = createContext<KeybindingContextValue | null>(null)

export type KeybindingProviderProps = {
  bindings: ParsedBinding[]
  pendingChordRef: RefObject<ParsedKeystroke[] | null>
  pendingChord: ParsedKeystroke[] | null
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  activeContexts: Set<KeybindingContextName>
  registerActiveContext: (context: KeybindingContextName) => void
  unregisterActiveContext: (context: KeybindingContextName) => void
  handlerRegistryRef: RefObject<Map<string, Set<HandlerRegistration>>>
  children: React.ReactNode
}

export function KeybindingProvider({
  bindings,
  pendingChordRef,
  pendingChord,
  setPendingChord,
  activeContexts,
  registerActiveContext,
  unregisterActiveContext,
  handlerRegistryRef,
  children,
}: KeybindingProviderProps): React.ReactNode {
  const getDisplayText = useCallback(
    (action: string, context: KeybindingContextName) =>
      getBindingDisplayText(action, context, bindings),
    [bindings],
  )

  const registerHandler = useCallback(
    (registration: HandlerRegistration) => {
      const registry = handlerRegistryRef.current
      if (!registry) return () => {}
      let set = registry.get(registration.action)
      if (!set) {
        set = new Set()
        registry.set(registration.action, set)
      }
      set.add(registration)
      return () => {
        const handlers = registry.get(registration.action)
        if (!handlers) return
        handlers.delete(registration)
        if (handlers.size === 0) {
          registry.delete(registration.action)
        }
      }
    },
    [handlerRegistryRef],
  )

  const invokeAction = useCallback(
    (action: string): boolean => {
      const registry = handlerRegistryRef.current
      if (!registry) return false
      const handlers = registry.get(action)
      if (!handlers || handlers.size === 0) return false
      for (const reg of handlers) {
        if (activeContexts.has(reg.context) || reg.context === 'Global') {
          reg.handler()
          return true
        }
      }
      return false
    },
    [activeContexts, handlerRegistryRef],
  )

  const resolve = useCallback(
    (input: string, key: Key, contexts: KeybindingContextName[]) =>
      resolveKeyWithChordState(
        input,
        key,
        contexts,
        bindings,
        pendingChordRef.current,
      ),
    [bindings, pendingChordRef],
  )

  const value = useMemo<KeybindingContextValue>(
    () => ({
      resolve,
      setPendingChord,
      getDisplayText,
      bindings,
      pendingChord,
      activeContexts,
      registerActiveContext,
      unregisterActiveContext,
      registerHandler,
      invokeAction,
    }),
    [
      resolve,
      setPendingChord,
      getDisplayText,
      bindings,
      pendingChord,
      activeContexts,
      registerActiveContext,
      unregisterActiveContext,
      registerHandler,
      invokeAction,
    ],
  )

  return (
    <KeybindingContext.Provider value={value}>
      {children}
    </KeybindingContext.Provider>
  )
}

export function useKeybindingContext(): KeybindingContextValue {
  const ctx = useContext(KeybindingContext)
  if (!ctx) {
    throw new Error(
      'useKeybindingContext must be used within KeybindingProvider',
    )
  }
  return ctx
}

export function useOptionalKeybindingContext(): KeybindingContextValue | null {
  return useContext(KeybindingContext)
}

export function useRegisterKeybindingContext(
  context: KeybindingContextName,
  isActive = true,
): void {
  const keybindingContext = useOptionalKeybindingContext()
  useLayoutEffect(() => {
    if (!keybindingContext || !isActive) return
    keybindingContext.registerActiveContext(context)
    return () => {
      keybindingContext.unregisterActiveContext(context)
    }
  }, [keybindingContext, context, isActive])
}
