import React, { createContext, useContext } from 'react'
import type { FpsMetrics } from '../utilities/fps_tracker.js'

const EMPTY_METRICS: FpsMetrics = {
  fps: 60,
  frameCount: 0,
  droppedFrames: 0,
  avgFrameMs: 0,
  maxFrameMs: 0,
  p95FrameMs: 0,
}

export const FpsMetricsContext = createContext<FpsMetrics>(EMPTY_METRICS)

export function FpsMetricsProvider({
  metrics,
  children,
}: {
  metrics: FpsMetrics
  children: React.ReactNode
}): React.ReactNode {
  return (
    <FpsMetricsContext.Provider value={metrics}>
      {children}
    </FpsMetricsContext.Provider>
  )
}

export function useFpsMetrics(): FpsMetrics {
  return useContext(FpsMetricsContext)
}
