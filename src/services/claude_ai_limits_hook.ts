/**
 * React hook subscribing to live Claude.ai rate-limit status updates.
 */

import { useEffect, useState } from 'react'
import {
  type ClaudeAiLimits,
  getCurrentLimits,
  statusListeners,
} from './claude_ai_limits.js'

/**
 * Subscribes a React component to live `ClaudeAiLimits` transitions.
 */
export function useClaudeAiLimits(): ClaudeAiLimits {
  const [limits, setLimits] = useState<ClaudeAiLimits>(() => ({
    ...getCurrentLimits(),
  }))

  useEffect(() => {
    const listener = (nextLimits: ClaudeAiLimits) => {
      setLimits({ ...nextLimits })
    }
    statusListeners.add(listener)
    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
