import { useCallback, useRef } from 'react'

/**
 * Manages the active `AbortController` for an in-flight streaming turn so
 * `Escape` or `Ctrl+C` cancels cleanly without leaking stale controllers.
 */
export function useCancelRequest() {
  const controllerRef = useRef<AbortController | null>(null)

  const beginRequest = useCallback((): AbortController => {
    controllerRef.current?.abort()
    const next = new AbortController()
    controllerRef.current = next
    return next
  }, [])

  const cancelRequest = useCallback((): boolean => {
    const active = controllerRef.current
    if (!active || active.signal.aborted) return false
    active.abort()
    controllerRef.current = null
    return true
  }, [])

  const clearRequest = useCallback(() => {
    controllerRef.current = null
  }, [])

  return {
    beginRequest,
    cancelRequest,
    clearRequest,
    isActive: () =>
      controllerRef.current !== null && !controllerRef.current.signal.aborted,
  }
}
