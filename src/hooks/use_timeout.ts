import { useEffect, useRef } from 'react'

export function useTimeout(
  callback: () => void,
  delayMs: number | null,
): void {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (delayMs === null) return
    const timer = setTimeout(() => {
      cbRef.current()
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, [delayMs])
}
