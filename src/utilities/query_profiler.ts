/**
 * Opt-in per-query latency and memory profiler (`COPILOT_CLI_PROFILE_QUERY=1`).
 */

import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'
import {
  formatMs,
  formatTimelineLine,
  getPerformance,
} from './profiler_base.js'

interface ProfileMark {
  name: string
  timeMs: number
  rssBytes: number
  heapUsedBytes: number
}

const PROFILE_ENABLED = isEnvTruthy(process.env.COPILOT_CLI_PROFILE_QUERY)

let queryCount = 0
let firstTokenTime: number | null = null
let marks: ProfileMark[] = []

/**
 * Starts a fresh query profile capture when `COPILOT_CLI_PROFILE_QUERY=1`.
 */
export function startQueryProfile(): void {
  if (!PROFILE_ENABLED) return
  queryCount++
  firstTokenTime = null
  marks = []
  queryCheckpoint('query_user_input_received')
}

/**
 * Records a named performance checkpoint and memory snapshot.
 */
export function queryCheckpoint(name: string): void {
  if (!PROFILE_ENABLED) return
  const perf = getPerformance()
  const now = perf.now()
  if (name === 'query_first_chunk_received' && firstTokenTime === null) {
    firstTokenTime = now
  }
  const mem = process.memoryUsage()
  marks.push({
    name,
    timeMs: now,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
  })
}

/**
 * Marks the end of a query profile capture.
 */
export function endQueryProfile(): void {
  queryCheckpoint('query_profile_end')
}

/**
 * Emits a formatted 80-column query latency timeline report to debug logs.
 */
export function logQueryProfileReport(): void {
  if (!PROFILE_ENABLED || marks.length === 0) return
  const origin = marks[0]!.timeMs
  const lines: string[] = [
    `================ Query Profile #${queryCount} ================`,
  ]
  for (let i = 0; i < marks.length; i++) {
    const current = marks[i]!
    const prev = i > 0 ? marks[i - 1]! : current
    const totalMs = current.timeMs - origin
    const deltaMs = current.timeMs - prev.timeMs
    const severity =
      deltaMs > 1000
        ? ' [VERY SLOW]'
        : deltaMs > 100
          ? ' [SLOW]'
          : deltaMs > 50 &&
              (current.name.includes('git') ||
                current.name.includes('tool_schema') ||
                current.name.includes('client'))
            ? ' [WATCH]'
            : ''
    lines.push(
      formatTimelineLine(
        totalMs,
        deltaMs,
        `${current.name}${severity}`,
        {
          rss: current.rssBytes,
          heapUsed: current.heapUsedBytes,
          heapTotal: 0,
          external: 0,
          arrayBuffers: 0,
        },
        8,
        8,
      ),
    )
  }
  if (firstTokenTime !== null) {
    lines.push(`TTFT: ${formatMs(firstTokenTime - origin)}`)
  }
  lines.push('==============================================================')
  logForDebugging(lines.join('\n'))
}
