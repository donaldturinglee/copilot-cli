import { useEffect, useState } from 'react'

export function useElapsedTime(
  startTimeMs: number,
  active = true,
  intervalMs = 250,
): number {
  const [elapsedMs, setElapsedMs] = useState(() =>
    Math.max(0, Date.now() - startTimeMs),
  )

  useEffect(() => {
    if (!active) return
    setElapsedMs(Math.max(0, Date.now() - startTimeMs))
    const timer = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startTimeMs))
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, [startTimeMs, active, intervalMs])

  return elapsedMs
}
