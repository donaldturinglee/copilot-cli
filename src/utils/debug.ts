import { appendFile, mkdir, symlink, unlink } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { type BufferedWriter, createBufferedWriter } from './buffered_writer.js'
import { registerCleanup } from './cleanup_registry.js'
import {
  type DebugFilter,
  parseDebugFilter,
  shouldShowDebugMessage,
} from './debug_filter.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './env_utils.js'
import { getFsImplementation } from './fs_operations.js'
import { writeToStderr } from './process.js'
import { jsonStringify } from './slow_operations.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  const raw = process.env.COPILOT_CLI_DEBUG_LOG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
})

let runtimeDebugEnabled = false

export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStderr() ||
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    getDebugFilePath() !== null
  )
})

/**
 * Enables debug logging mid-session (e.g. via /debug).
 * Returns true if logging was already active.
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode()
  runtimeDebugEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

export const getDebugFilter = memoize((): DebugFilter | null => {
  const debugArg = process.argv.find(arg => arg.startsWith('--debug='))
  if (!debugArg) {
    return null
  }
  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})

export const isDebugToStderr = memoize((): boolean => {
  return (
    process.argv.includes('--debug-to-stderr') || process.argv.includes('-d2e')
  )
})

export const getDebugFilePath = memoize((): string | null => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!
    if (arg.startsWith('--debug-file=')) {
      return arg.substring('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < process.argv.length) {
      return process.argv[i + 1]!
    }
  }
  return null
})

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStderr()) {
    return false
  }

  if (!isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  const filter = getDebugFilter()
  return shouldShowDebugMessage(message, filter)
}

let hasFormattedOutput = false

export function setHasFormattedOutput(value: boolean): void {
  hasFormattedOutput = value
}

export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

let debugWriter: BufferedWriter | null = null
let pendingWrite: Promise<void> = Promise.resolve()

async function appendAsync(
  needMkdir: boolean,
  dir: string,
  filePath: string,
  content: string,
): Promise<void> {
  if (needMkdir) {
    await mkdir(dir, { recursive: true }).catch(() => {})
  }
  await appendFile(filePath, content)
  void updateLatestDebugLogSymlink()
}

function noop(): void {}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        const logPath = getDebugLogPath()
        const dir = dirname(logPath)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          if (needMkdir) {
            try {
              getFsImplementation().mkdirSync(dir)
            } catch {
              // Directory already exists
            }
          }
          getFsImplementation().appendFileSync(logPath, content)
          void updateLatestDebugLogSymlink()
          return
        }
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, logPath, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingWrite
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = { level: 'debug' },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return
  }
  if (!shouldLogDebugMessage(message)) {
    return
  }

  let formattedMessage = message
  if (hasFormattedOutput && formattedMessage.includes('\n')) {
    formattedMessage = jsonStringify(formattedMessage)
  }
  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${formattedMessage.trim()}\n`
  if (isDebugToStderr()) {
    writeToStderr(output)
    return
  }

  getDebugWriter().write(output)
}

export function getDebugLogPath(): string {
  return (
    getDebugFilePath() ??
    process.env.COPILOT_CLI_DEBUG_LOGS_DIR ??
    join(getClaudeConfigHomeDir(), 'debug', `${getSessionId()}.txt`)
  )
}

const updateLatestDebugLogSymlink = memoize(async (): Promise<void> => {
  try {
    const debugLogPath = getDebugLogPath()
    const debugLogsDir = dirname(debugLogPath)
    const latestSymlinkPath = join(debugLogsDir, 'latest')

    await unlink(latestSymlinkPath).catch(() => {})
    await symlink(debugLogPath, latestSymlinkPath)
  } catch {
    // Silently fail if symlink creation fails
  }
})
