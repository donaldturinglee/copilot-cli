import React, { createContext, useContext, useMemo, useState } from 'react'

export type SessionUiStats = {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  totalCostUsd: number
}

export type StatsContextValue = {
  stats: SessionUiStats
  updateStats: (patch: Partial<SessionUiStats>) => void
}

const INITIAL_STATS: SessionUiStats = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalCostUsd: 0,
}

const StatsContext = createContext<StatsContextValue>({
  stats: INITIAL_STATS,
  updateStats: () => {},
})

export function StatsProvider({
  initialStats,
  children,
}: {
  initialStats?: Partial<SessionUiStats>
  children: React.ReactNode
}): React.ReactNode {
  const [stats, setStats] = useState<SessionUiStats>({
    ...INITIAL_STATS,
    ...initialStats,
  })

  const value = useMemo<StatsContextValue>(
    () => ({
      stats,
      updateStats: patch => setStats(prev => ({ ...prev, ...patch })),
    }),
    [stats],
  )

  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>
}

export function useStats(): StatsContextValue {
  return useContext(StatsContext)
}
