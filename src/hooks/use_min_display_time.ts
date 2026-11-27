import { useEffect, useRef, useState } from 'react'

export function useMinDisplayTime(
  active: boolean,
  minMs = 300,
): boolean {
  const [visible, setVisible] = useState(active)
  const shownAtRef = useRef<number | null>(active ? Date.now() : null)

  useEffect(() => {
    if (active) {
      if (shownAtRef.current === null) {
        shownAtRef.current = Date.now()
      }
      setVisible(true)
      return
    }

    if (shownAtRef.current === null) {
      setVisible(false)
      return
    }

    const elapsed = Date.now() - shownAtRef.current
    const remaining = Math.max(0, minMs - elapsed)
    if (remaining === 0) {
      shownAtRef.current = null
      setVisible(false)
      return
    }

    const timer = setTimeout(() => {
      shownAtRef.current = null
      setVisible(false)
    }, remaining)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, [active, minMs])

  return visible
}
