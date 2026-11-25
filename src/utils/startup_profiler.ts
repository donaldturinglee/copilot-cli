import { dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './env_utils.js'
import { getFsImplementation } from './fs_operations.js'
import {
  formatMs,
  formatTimelineLine,
  getPerformance,
} from './profiler_base.js'
import { writeFileSyncDeprecated } from './slow_operations.js'

const DETAILED_PROFILING = isEnvTruthy(process.env.COPILOT_CLI_PROFILE_STARTUP)
const STATSIG_SAMPLE_RATE = 0.005
const STATSIG_LOGGING_SAMPLED = Math.random() < STATSIG_SAMPLE_RATE
const SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED

const PHASE_DEFINITIONS: Record<string, readonly [string, string]> = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time: ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time: ['cli_entry', 'main_after_run'],
}

const memorySnapshots: NodeJS.MemoryUsage[] = []
let reported = false

export function isDetailedProfilingEnabled(): boolean {
  return DETAILED_PROFILING
}

export function getStartupPerfLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'startup-perf', `${getSessionId()}.txt`)
}

export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return
  getPerformance().mark(name)
  if (DETAILED_PROFILING) {
    memorySnapshots.push(process.memoryUsage())
  }
}

export function logStartupPerf(): void {
  if (!STATSIG_LOGGING_SAMPLED) return
  try {
    const perf = getPerformance()
    const marks = perf.getEntriesByType('mark')
    if (marks.length === 0) return

    const markMap = new Map<string, number>()
    for (const mark of marks) {
      if (!markMap.has(mark.name)) {
        markMap.set(mark.name, mark.startTime)
      }
    }

    const metadata: Record<string, number> = {
      checkpoint_count: marks.length,
    }
    for (const [phaseName, [startName, endName]] of Object.entries(
      PHASE_DEFINITIONS,
    )) {
      const start = markMap.get(startName)
      const end = markMap.get(endName)
      if (start !== undefined && end !== undefined && end >= start) {
        metadata[`${phaseName}_ms`] = Math.round(end - start)
      }
    }

    logEvent('tengu_startup_perf', metadata)
  } catch {
    // Ignore profiler reporting errors
  }
}

export function profileReport(): void {
  if (reported) return
  reported = true

  logStartupPerf()

  if (!DETAILED_PROFILING) return

  try {
    const perf = getPerformance()
    const marks = perf.getEntriesByType('mark')
    if (marks.length === 0) return

    const firstTime = marks[0]!.startTime
    const lines: string[] = ['='.repeat(80), 'Startup Performance Profile', '='.repeat(80)]
    let prevTime = firstTime

    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i]!
      const totalMs = mark.startTime - firstTime
      const deltaMs = mark.startTime - prevTime
      prevTime = mark.startTime
      lines.push(
        formatTimelineLine(
          totalMs,
          deltaMs,
          mark.name,
          memorySnapshots[i],
          8,
          7,
        ),
      )
    }

    const lastTime = marks[marks.length - 1]!.startTime
    lines.push('='.repeat(80))
    lines.push(`Total startup time: ${formatMs(lastTime - firstTime)}ms`)
    lines.push('='.repeat(80))

    const report = lines.join('\n') + '\n'
    const logPath = getStartupPerfLogPath()
    getFsImplementation().mkdirSync(dirname(logPath))
    writeFileSyncDeprecated(logPath, report, { encoding: 'utf-8' })
    logForDebugging(report)
  } catch {
    // Ignore detailed report write failures
  }
}

if (SHOULD_PROFILE) {
  profileCheckpoint('profiler_initialized')
}
