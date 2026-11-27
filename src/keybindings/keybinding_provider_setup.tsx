import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNotifications } from '../context/notifications.js'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { useInput } from '../ink/hooks/use_input.js'
import { useOptionalAppStateStore } from '../state/app_state.js'
import { logForDebugging } from '../utilities/debug.js'
import {
  type HandlerRegistration,
  KeybindingProvider,
} from './keybinding_context.js'
import {
  initializeKeybindingWatcher,
  type KeybindingsLoadResult,
  loadKeybindingsSyncWithWarnings,
  subscribeToKeybindingChanges,
} from './load_user_bindings.js'
import { resolveKeyWithChordState } from './resolver.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'
import type { KeybindingWarning } from './validate.js'

export const CHORD_TIMEOUT_MS = 1000

function KeybindingWarningNotifier({
  warnings,
}: {
  warnings: KeybindingWarning[]
}): null {
  const { addNotification, removeNotification } = useNotifications()

  useEffect(() => {
    if (warnings.length === 0) {
      removeNotification('keybinding-config-warning')
      return
    }
    const errorCount = warnings.filter(w => w.severity === 'error').length
    const warnCount = warnings.filter(w => w.severity === 'warning').length
    const parts: string[] = []
    if (errorCount > 0) {
      parts.push(`${errorCount} keybinding ${errorCount === 1 ? 'error' : 'errors'}`)
    }
    if (warnCount > 0) {
      parts.push(`${warnCount} ${warnCount === 1 ? 'warning' : 'warnings'}`)
    }
    addNotification({
      key: 'keybinding-config-warning',
      text: `Found ${parts.join(' and ')} · /doctor for details`,
      color: errorCount > 0 ? 'error' : 'warning',
      priority: errorCount > 0 ? 'immediate' : 'high',
      timeoutMs: 60000,
    })
  }, [warnings, addNotification, removeNotification])

  return null
}

type ChordInterceptorProps = {
  bindings: ParsedBinding[]
  pendingChordRef: React.RefObject<ParsedKeystroke[] | null>
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  activeContexts: Set<KeybindingContextName>
  handlerRegistryRef: React.RefObject<Map<string, Set<HandlerRegistration>>>
}

/**
 * Registers `useInput` BEFORE all child components so multi-keystroke chords
 * (e.g. `ctrl+x ctrl+e`) intercept both the prefix and completion keystroke
 * with `event.stopImmediatePropagation()`, preventing any character leakage
 * into text inputs or editors.
 */
function ChordInterceptor({
  bindings,
  pendingChordRef,
  setPendingChord,
  activeContexts,
  handlerRegistryRef,
}: ChordInterceptorProps): null {
  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if ((key.wheelUp || key.wheelDown) && pendingChordRef.current === null) {
          return
        }

        const registry = handlerRegistryRef.current
        const handlerContexts = new Set<KeybindingContextName>()
        if (registry) {
          for (const handlers of registry.values()) {
            for (const reg of handlers) {
              handlerContexts.add(reg.context)
            }
          }
        }

        const contexts: KeybindingContextName[] = [
          ...activeContexts,
          ...handlerContexts,
          'Global',
        ]
        const wasInChord = pendingChordRef.current !== null
        const result = resolveKeyWithChordState(
          input,
          key,
          contexts,
          bindings,
          pendingChordRef.current,
        )

        switch (result.type) {
          case 'chord_started': {
            setPendingChord(result.pending)
            event.stopImmediatePropagation()
            break
          }
          case 'match': {
            setPendingChord(null)
            if (wasInChord) {
              const contextsSet = new Set(contexts)
              const handlers = registry?.get(result.action)
              if (handlers && handlers.size > 0) {
                for (const reg of handlers) {
                  if (contextsSet.has(reg.context)) {
                    reg.handler()
                    break
                  }
                }
              }
              // Always swallow the completing chord keystroke so it never leaks
              event.stopImmediatePropagation()
            }
            break
          }
          case 'chord_cancelled': {
            setPendingChord(null)
            event.stopImmediatePropagation()
            break
          }
          case 'unbound': {
            setPendingChord(null)
            event.stopImmediatePropagation()
            break
          }
          case 'none':
            break
        }
      },
      [bindings, pendingChordRef, setPendingChord, activeContexts, handlerRegistryRef],
    ),
  )

  return null
}

export type KeybindingSetupProps = {
  children: React.ReactNode
  /** Optional custom chord timeout in ms (defaults to 1000ms). */
  chordTimeoutMs?: number
  /** Disable filesystem watcher in isolated tests if desired. */
  enableWatcher?: boolean
  /** Optional custom keybindings file path. */
  keybindingsPath?: string
}

export function KeybindingSetup({
  children,
  chordTimeoutMs = CHORD_TIMEOUT_MS,
  enableWatcher = true,
  keybindingsPath,
}: KeybindingSetupProps): React.ReactNode {
  const hasAppState = useOptionalAppStateStore() !== null
  const [{ bindings, warnings }, setLoadResult] =
    useState<KeybindingsLoadResult>(() => {
      const result = loadKeybindingsSyncWithWarnings(keybindingsPath)
      logForDebugging(
        `[keybindings] KeybindingSetup initialized with ${result.bindings.length} bindings, ${result.warnings.length} warnings`,
      )
      return result
    })

  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] = useState<
    ParsedKeystroke[] | null
  >(null)
  const chordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handlerRegistryRef = useRef(
    new Map<string, Set<HandlerRegistration>>(),
  )
  const activeContextsRef = useRef(new Set<KeybindingContextName>())

  const registerActiveContext = useCallback(
    (context: KeybindingContextName) => {
      activeContextsRef.current.add(context)
    },
    [],
  )

  const unregisterActiveContext = useCallback(
    (context: KeybindingContextName) => {
      activeContextsRef.current.delete(context)
    },
    [],
  )

  const clearChordTimeout = useCallback(() => {
    if (chordTimeoutRef.current) {
      clearTimeout(chordTimeoutRef.current)
      chordTimeoutRef.current = null
    }
  }, [])

  const setPendingChord = useCallback(
    (pending: ParsedKeystroke[] | null) => {
      clearChordTimeout()
      if (pending !== null) {
        chordTimeoutRef.current = setTimeout(() => {
          chordTimeoutRef.current = null
          pendingChordRef.current = null
          setPendingChordState(null)
        }, chordTimeoutMs)
        if (typeof chordTimeoutRef.current.unref === 'function') {
          chordTimeoutRef.current.unref()
        }
      }
      pendingChordRef.current = pending
      setPendingChordState(pending)
    },
    [clearChordTimeout, chordTimeoutMs],
  )

  useEffect(() => {
    if (enableWatcher) {
      void initializeKeybindingWatcher(keybindingsPath)
    }
    const unsubscribe = subscribeToKeybindingChanges(result => {
      setLoadResult(result)
    })
    return () => {
      unsubscribe()
      clearChordTimeout()
    }
  }, [clearChordTimeout, enableWatcher, keybindingsPath])

  return (
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={activeContextsRef.current}
      registerActiveContext={registerActiveContext}
      unregisterActiveContext={unregisterActiveContext}
      handlerRegistryRef={handlerRegistryRef}
    >
      {hasAppState ? <KeybindingWarningNotifier warnings={warnings} /> : null}
      <ChordInterceptor
        bindings={bindings}
        pendingChordRef={pendingChordRef}
        setPendingChord={setPendingChord}
        activeContexts={activeContextsRef.current}
        handlerRegistryRef={handlerRegistryRef}
      />
      {children}
    </KeybindingProvider>
  )
}
