import React, { memo } from 'react'

export type OffscreenFreezeProps = {
  frozen: boolean
  children: React.ReactNode
}

/**
 * Main-screen stability guard: freezes already-rendered historical rows so
 * updates at the streaming tail do not trigger unnecessary React reconciles or
 * full-screen scrollback redraws.
 */
export const OffscreenFreeze = memo(
  function OffscreenFreeze({ children }: OffscreenFreezeProps): React.ReactNode {
    return <>{children}</>
  },
  (prev, next) => prev.frozen && next.frozen,
)
