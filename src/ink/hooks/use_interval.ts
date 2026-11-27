import { useEffect, useRef } from 'react'

export function useInterval(
  callback: () => void,
  delayMs: number | null,
): void {
  const savedCallback = useRef(callback)
  savedCallback.current = callback

  useEffect(() => {
    if (delayMs === null) return
    const timer = setInterval(() => {
      savedCallback.current()
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, [delayMs])
}
