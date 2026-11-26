import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'

export const MAX_WARNING_KEYS = 1000

const INTERNAL_WARNINGS = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
]

const BUILD_DIRECTORY_MARKERS = [
  '/build-ant/',
  '/build-external/',
  '/build-external-native/',
  '/build-ant-native/',
]

const warningCounts = new Map<string, number>()
let warningHandler: ((warning: Error) => void) | null = null

function isRunningFromBuildDirectory(): boolean {
  const candidates = [process.argv[1], process.execPath || process.argv[0]]
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = candidate.replace(/\\/g, '/')
    if (BUILD_DIRECTORY_MARKERS.some(marker => normalized.includes(marker))) {
      return true
    }
  }
  return false
}

export function resetWarningHandler(): void {
  if (warningHandler) {
    process.off('warning', warningHandler)
    warningHandler = null
  }
  warningCounts.clear()
}

export function initializeWarningHandler(): void {
  if (warningHandler && process.listeners('warning').includes(warningHandler)) {
    return
  }

  const isDevelopment =
    process.env.NODE_ENV === 'development' || isRunningFromBuildDirectory()

  if (!isDevelopment) {
    process.removeAllListeners('warning')
  }

  warningHandler = (warning: Error) => {
    try {
      const key = `${warning.name}: ${warning.message.slice(0, 50)}`
      const prevCount = warningCounts.get(key) ?? 0
      if (warningCounts.has(key) || warningCounts.size < MAX_WARNING_KEYS) {
        warningCounts.set(key, prevCount + 1)
      }

      const fullText = `${warning.name}: ${warning.message}`
      const isInternal = INTERNAL_WARNINGS.some(pattern =>
        pattern.test(fullText),
      )

      logEvent('tengu_node_warning', {
        is_internal: isInternal ? 1 : 0,
        occurrence_count: prevCount + 1,
        classname: warning.name as VerifiedNonSensitiveAnalyticsMetadata,
      })

      if (isEnvTruthy(process.env.CLAUDE_DEBUG)) {
        logForDebugging(
          `${isInternal ? '[Internal Warning]' : '[Warning]'} ${warning.toString()}`,
          { level: 'warn' },
        )
      }
    } catch {
      // Fail silently in warning handler
    }
  }

  process.on('warning', warningHandler)
}
