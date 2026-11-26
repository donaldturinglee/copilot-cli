import { writeSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { onExit } from 'signal-exit'
import {
  getIsInteractive,
  getIsScrollDraining,
  getLastMainRequestId,
  getSessionId,
  isSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import { runCleanupFunctions } from './cleanup_registry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPii } from './diag_logs.js'
import { isEnvTruthy } from './env_utils.js'
import { sleep, withTimeout } from './sleep.js'
import { profileReport } from './startup_profiler.js'

export type ExitReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
  | 'bypass_permissions_disabled'

export type GracefulShutdownHooks = {
  getSessionEndTimeoutMs?: () => number
  executeSessionEndHooks?: (
    reason: ExitReason,
    signal: AbortSignal,
  ) => Promise<void>
  flushAnalytics?: () => Promise<void>
  cleanupInkInstance?: () => void
  drainInkStdin?: () => void
  hasPersistedSessionForResumeHint?: () => string | null
}

const DISABLE_MOUSE_TRACKING = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l'
const DISABLE_MODIFY_OTHER_KEYS = '\x1b[>4m'
const DISABLE_KITTY_KEYBOARD = '\x1b[<u'
const DISABLE_FOCUS_EVENTS = '\x1b[?1004l'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const SHOW_CURSOR = '\x1b[?25h'
const CLEAR_ITERM2_PROGRESS = '\x1b]9;4;0;\x07'
const CLEAR_TERMINAL_TITLE = '\x1b]0;\x07'

const DEFAULT_SESSION_END_TIMEOUT_MS = 1500
const CLEANUP_TIMEOUT_MS = 2000
const ANALYTICS_FLUSH_TIMEOUT_MS = 500
const ORPHAN_CHECK_INTERVAL_MS = 30_000

let hooks: GracefulShutdownHooks = {}
let shutdownInProgress = false
let resumeHintPrinted = false
let failsafeTimer: ReturnType<typeof setTimeout> | null = null
let pendingShutdown: Promise<void> | undefined

export function registerGracefulShutdownHooks(
  nextHooks: Partial<GracefulShutdownHooks>,
): void {
  hooks = { ...hooks, ...nextHooks }
}

function getSessionEndTimeoutMs(): number {
  if (hooks.getSessionEndTimeoutMs) {
    return hooks.getSessionEndTimeoutMs()
  }
  const envVal = process.env.COPILOT_CLI_SESSIONEND_HOOKS_TIMEOUT_MS
  if (envVal) {
    const parsed = parseInt(envVal, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_SESSION_END_TIMEOUT_MS
}

function safeWriteStdoutSync(sequence: string): void {
  try {
    writeSync(1, sequence)
  } catch {
    // Stdout may already be closed
  }
}

function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) {
    return
  }

  safeWriteStdoutSync(DISABLE_MOUSE_TRACKING)
  try {
    hooks.cleanupInkInstance?.()
  } catch {
    // Ignore Ink cleanup errors during shutdown
  }

  safeWriteStdoutSync(
    DISABLE_MODIFY_OTHER_KEYS +
      DISABLE_KITTY_KEYBOARD +
      DISABLE_FOCUS_EVENTS +
      DISABLE_BRACKETED_PASTE +
      SHOW_CURSOR +
      CLEAR_ITERM2_PROGRESS,
  )

  if (!isEnvTruthy(process.env.COPILOT_CLI_DISABLE_TERMINAL_TITLE)) {
    if (process.platform === 'win32') {
      process.title = ''
    } else {
      safeWriteStdoutSync(CLEAR_TERMINAL_TITLE)
    }
  }
}

function printResumeHint(): void {
  if (
    resumeHintPrinted ||
    !process.stdout.isTTY ||
    !getIsInteractive() ||
    isSessionPersistenceDisabled()
  ) {
    return
  }

  const resumeArg = hooks.hasPersistedSessionForResumeHint?.()
  if (!resumeArg) {
    return
  }

  resumeHintPrinted = true
  safeWriteStdoutSync(
    `\n\x1b[2mResume this session with:\nclaude --resume ${resumeArg}\x1b[0m\n`,
  )
}

function forceExit(exitCode: number): void {
  if (failsafeTimer) {
    clearTimeout(failsafeTimer)
    failsafeTimer = null
  }
  try {
    hooks.drainInkStdin?.()
  } catch {
    // Ignore stdin drain errors
  }

  try {
    process.exit(exitCode)
  } catch (error) {
    if (process.env.NODE_ENV === 'test') {
      throw error
    }
    try {
      process.kill(process.pid, 'SIGKILL')
    } catch {
      // Nothing left to do
    }
  }
}

export const setupGracefulShutdown = memoize((): void => {
  onExit(() => {})

  process.on('SIGINT', () => {
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    logForDiagnosticsNoPii('info', 'signal_sigint')
    void gracefulShutdown(0)
  })

  process.on('SIGTERM', () => {
    logForDiagnosticsNoPii('info', 'signal_sigterm')
    void gracefulShutdown(143)
  })

  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      logForDiagnosticsNoPii('info', 'signal_sighup')
      void gracefulShutdown(129)
    })

    if (process.stdin.isTTY) {
      const orphanTimer = setInterval(() => {
        if (getIsScrollDraining()) {
          return
        }
        if (!process.stdout.writable || !process.stdin.readable) {
          clearInterval(orphanTimer)
          void gracefulShutdown(129)
        }
      }, ORPHAN_CHECK_INTERVAL_MS)
      orphanTimer.unref?.()
    }
  }

  process.on('uncaughtException', error => {
    logForDiagnosticsNoPii('error', 'uncaught_exception', {
      error_name: error.name,
      error_message: error.message.slice(0, 2000),
    })
    logEvent('tengu_uncaught_exception', {
      error_name: error.name as VerifiedNonSensitiveAnalyticsMetadata,
    })
  })

  process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logForDiagnosticsNoPii('error', 'unhandled_rejection', {
      error_name: err.name,
      error_message: err.message.slice(0, 2000),
      error_stack: (err.stack ?? '').slice(0, 4000),
    })
    logEvent('tengu_unhandled_rejection', {
      error_name: err.name as VerifiedNonSensitiveAnalyticsMetadata,
    })
  })
})

export function isShuttingDown(): boolean {
  return shutdownInProgress
}

export function resetShutdownState(): void {
  shutdownInProgress = false
  resumeHintPrinted = false
  if (failsafeTimer) {
    clearTimeout(failsafeTimer)
    failsafeTimer = null
  }
  pendingShutdown = undefined
}

export function getPendingShutdownForTesting(): Promise<void> | undefined {
  return pendingShutdown
}

export function gracefulShutdownSync(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => unknown
    setAppState?: (updater: (prev: unknown) => unknown) => void
  },
): void {
  process.exitCode = exitCode
  pendingShutdown = gracefulShutdown(exitCode, reason, options)
    .catch(error => {
      logForDebugging(`Graceful shutdown error: ${error}`, { level: 'error' })
      cleanupTerminalModes()
      printResumeHint()
      forceExit(exitCode)
    })
    .catch(() => {})
}

export async function gracefulShutdown(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => unknown
    setAppState?: (updater: (prev: unknown) => unknown) => void
    finalMessage?: string
  },
): Promise<void> {
  if (shutdownInProgress) {
    return
  }
  shutdownInProgress = true
  process.exitCode = exitCode

  const sessionEndTimeoutMs = getSessionEndTimeoutMs()
  const failsafeBudgetMs = Math.max(5000, sessionEndTimeoutMs + 3500)
  failsafeTimer = setTimeout(() => {
    cleanupTerminalModes()
    printResumeHint()
    forceExit(exitCode)
  }, failsafeBudgetMs)
  failsafeTimer.unref?.()

  cleanupTerminalModes()
  printResumeHint()

  try {
    await withTimeout(
      runCleanupFunctions(),
      CLEANUP_TIMEOUT_MS,
      'Cleanup functions timed out during graceful shutdown',
    )
  } catch (error) {
    logForDebugging(`Cleanup timeout/error during shutdown: ${error}`, {
      level: 'warn',
    })
  }

  if (hooks.executeSessionEndHooks) {
    try {
      await hooks.executeSessionEndHooks(
        reason,
        AbortSignal.timeout(sessionEndTimeoutMs),
      )
    } catch (error) {
      logForDebugging(`SessionEnd hooks failed: ${error}`, { level: 'warn' })
    }
  }

  profileReport()

  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      session_id: getSessionId() as VerifiedNonSensitiveAnalyticsMetadata,
      request_id: lastRequestId as VerifiedNonSensitiveAnalyticsMetadata,
    })
  }

  if (hooks.flushAnalytics) {
    try {
      await Promise.race([
        hooks.flushAnalytics(),
        sleep(ANALYTICS_FLUSH_TIMEOUT_MS, undefined, { unref: true }),
      ])
    } catch {
      // Ignore analytics flush errors on exit
    }
  }

  if (options?.finalMessage) {
    try {
      writeSync(2, options.finalMessage + '\n')
    } catch {
      // Stderr may be closed
    }
  }

  forceExit(exitCode)
}
