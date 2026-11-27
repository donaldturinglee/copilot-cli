import { useCallback, useEffect, useRef, useState } from 'react'

export const DOUBLE_PRESS_TIMEOUT_MS = 800

export type UseDoublePressResult = {
  pending: boolean
  trigger: () => void
  reset: () => void
}

/**
 * Double-press confirmation hook (e.g. press Ctrl+C twice within 800ms to exit).
 */
export function useDoublePress(
  onConfirm: () => void,
  onFirstPress?: () => void,
  timeoutMs: number = DOUBLE_PRESS_TIMEOUT_MS,
): UseDoublePressResult {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmRef = useRef(onConfirm)
  const firstRef = useRef(onFirstPress)
  confirmRef.current = onConfirm
  firstRef.current = onFirstPress

  const reset = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = false
    setPending(false)
  }, [])

  const trigger = useCallback(() => {
    if (pendingRef.current) {
      reset()
      confirmRef.current()
      return
    }
    pendingRef.current = true
    setPending(true)
    firstRef.current?.()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      pendingRef.current = false
      setPending(false)
    }, timeoutMs)
    if (typeof timerRef.current.unref === 'function') {
      timerRef.current.unref()
    }
  }, [reset, timeoutMs])

  useEffect(() => reset, [reset])

  return { pending, trigger, reset }
}
