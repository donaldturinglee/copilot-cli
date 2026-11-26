/**
 * Lightweight turn latency profiler for headless `-p` / SDK invocations.
 */

import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'
import { formatMs, getPerformance } from './profiler_base.js'

const HEADLESS_PROFILE_ENABLED = isEnvTruthy(
  process.env.COPILOT_CLI_PROFILE_HEADLESS,
)

let turnOriginMs = 0
let checkpoints: Array<{ name: string; offsetMs: number }> = []

/**
 * Starts timing a headless turn.
 */
export function headlessProfilerStartTurn(): void {
  if (!HEADLESS_PROFILE_ENABLED) return
  turnOriginMs = getPerformance().now()
  checkpoints = [{ name: 'turn_start', offsetMs: 0 }]
}

/**
 * Records a named checkpoint relative to `turn_start`.
 */
export function headlessProfilerCheckpoint(name: string): void {
  if (!HEADLESS_PROFILE_ENABLED || turnOriginMs === 0) return
  checkpoints.push({
    name,
    offsetMs: getPerformance().now() - turnOriginMs,
  })
}

/**
 * Flushes the recorded headless turn checkpoints to debug logs.
 */
export function logHeadlessProfilerTurn(): void {
  if (!HEADLESS_PROFILE_ENABLED || checkpoints.length === 0) return
  const summary = checkpoints
    .map(cp => `${cp.name}=${formatMs(cp.offsetMs)}`)
    .join(' ')
  logForDebugging(`[headless-profile] ${summary}`)
  checkpoints = []
  turnOriginMs = 0
}
