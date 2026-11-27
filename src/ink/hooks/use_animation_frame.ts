import { useEffect, useState } from 'react'
import { useClock } from '../components/clock_context.js'

/**
 * Subscribe to the shared animation clock at `intervalMs` (default 50ms / 20Hz).
 * Returns the monotonically advancing timestamp in milliseconds.
 */
export function useAnimationFrame(
  intervalMs = 50,
  enabled = true,
): number {
  const clock = useClock()
  const [time, setTime] = useState<number>(() => clock?.now() ?? Date.now())

  useEffect(() => {
    if (!enabled) return
    if (clock) {
      return clock.subscribe(intervalMs, setTime)
    }
    const timer = setInterval(() => {
      setTime(Date.now())
    }, Math.max(16, intervalMs))
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, [clock, intervalMs, enabled])

  return time
}
