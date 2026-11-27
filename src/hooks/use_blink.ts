import { useEffect, useState } from 'react'

export function useBlink(intervalMs = 530, enabled = true): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!enabled) {
      setVisible(true)
      return
    }
    const timer = setInterval(() => {
      setVisible(v => !v)
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, [intervalMs, enabled])

  return visible
}
