/**
 * Immutable per-`query()` runtime gate snapshot captured once at loop entry.
 */

import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGateCachedMayBeStale } from '../services/analytics/growthbook.js'
import type { SessionId } from '../types/ids.js'
import { isEnvTruthy } from '../utilities/env_utils.js'

export interface QueryConfig {
  sessionId: SessionId
  gates: {
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
    fastModeEnabled: boolean
  }
}

/**
 * Captures the immutable `QueryConfig` snapshot at the start of `queryLoop()`.
 */
export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: getSessionId(),
    gates: {
      streamingToolExecution: checkStatsigFeatureGateCachedMayBeStale(
        'tengu_streaming_tool_execution2',
      ),
      emitToolUseSummaries: isEnvTruthy(
        process.env.COPILOT_CLI_EMIT_TOOL_USE_SUMMARIES,
      ),
      isAnt: process.env.USER_TYPE === 'ant',
      fastModeEnabled: !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_FAST_MODE),
    },
  }
}
