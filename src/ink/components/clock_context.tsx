import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react'

export type ClockSubscriber = (now: number) => void

export type AnimationClock = {
  subscribe(intervalMs: number, cb: ClockSubscriber): () => void
  now(): number
}

class SharedAnimationClock implements AnimationClock {
  private readonly subscribers = new Map<
    ClockSubscriber,
    { intervalMs: number; lastRun: number }
  >()
  private timer: ReturnType<typeof setInterval> | null = null
  private activeInterval = 50

  subscribe(intervalMs: number, cb: ClockSubscriber): () => void {
    const safeInterval = Math.max(16, intervalMs)
    this.subscribers.set(cb, { intervalMs: safeInterval, lastRun: Date.now() })
    this.reschedule()
    return () => {
      this.subscribers.delete(cb)
      this.reschedule()
    }
  }

  now(): number {
    return Date.now()
  }

  private reschedule(): void {
    if (this.subscribers.size === 0) {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
      return
    }
    let minInterval = 1000
    for (const sub of this.subscribers.values()) {
      if (sub.intervalMs < minInterval) minInterval = sub.intervalMs
    }
    if (this.timer && this.activeInterval === minInterval) return
    if (this.timer) clearInterval(this.timer)
    this.activeInterval = minInterval
    this.timer = setInterval(() => {
      const now = Date.now()
      for (const [cb, meta] of [...this.subscribers.entries()]) {
        if (now - meta.lastRun >= meta.intervalMs) {
          meta.lastRun = now
          cb(now)
        }
      }
    }, minInterval)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.subscribers.clear()
  }
}

export const ClockContext = createContext<AnimationClock | null>(null)

export function ClockProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const clockRef = useRef<SharedAnimationClock | null>(null)
  if (!clockRef.current) {
    clockRef.current = new SharedAnimationClock()
  }
  const clock = useMemo<AnimationClock>(() => clockRef.current!, [])

  useEffect(() => {
    const instance = clockRef.current
    return () => {
      instance?.dispose()
    }
  }, [])

  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}

export function useClock(): AnimationClock | null {
  return useContext(ClockContext)
}
