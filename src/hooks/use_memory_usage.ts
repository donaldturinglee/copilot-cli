import { useEffect, useState } from 'react'

export type MemoryUsageSnapshot = {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
}

function readMemoryUsage(): MemoryUsageSnapshot {
  const m = process.memoryUsage()
  const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10
  return {
    rssMb: toMb(m.rss),
    heapUsedMb: toMb(m.heapUsed),
    heapTotalMb: toMb(m.heapTotal),
  }
}

export function useMemoryUsage(intervalMs = 5000, enabled = true): MemoryUsageSnapshot {
  const [snapshot, setSnapshot] = useState<MemoryUsageSnapshot>(readMemoryUsage)

  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      setSnapshot(readMemoryUsage())
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, [intervalMs, enabled])

  return snapshot
}
