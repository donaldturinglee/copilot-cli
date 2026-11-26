import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import {
  setLastApiRequest,
  setLastApiRequestMessages,
} from '../bootstrap/state.js'
import type { QuerySource } from '../constants/query_source.js'
import { TICK_TAG } from '../constants/xml.js'
import {
  type LogOption,
  type SerializedMessage,
  sortLogs,
} from '../types/logs.js'
import { CACHE_PATHS } from './cache_paths.js'
import { isEnvTruthy } from './env_utils.js'
import { toError } from './errors.js'
import { isFeatureEnabled } from './feature_flags.js'
import { jsonParse } from './slow_operations.js'

const DISPLAY_TAG_PATTERN =
  /<(?:ide_opened_file|ide_selection|command-name|command-message|command-args|local-command-stdout|system-reminder)[^>]*>[\s\S]*?<\/(?:ide_opened_file|ide_selection|command-name|command-message|command-args|local-command-stdout|system-reminder)>/g

function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(DISPLAY_TAG_PATTERN, '').trim()
}

function stripDisplayTags(text: string): string {
  const stripped = stripDisplayTagsAllowEmpty(text)
  return stripped || text
}

function isEssentialTrafficOnly(): boolean {
  return isEnvTruthy(process.env.COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC)
}

/**
 * Gets the display title for a log/session with fallback logic.
 */
export function getLogDisplayTitle(
  log: LogOption,
  defaultTitle?: string,
): string {
  const isAutonomousPrompt = log.firstPrompt?.startsWith(`<${TICK_TAG}>`)
  const strippedFirstPrompt = log.firstPrompt
    ? stripDisplayTagsAllowEmpty(log.firstPrompt)
    : ''
  const useFirstPrompt = strippedFirstPrompt && !isAutonomousPrompt
  const title =
    log.agentName ||
    log.customTitle ||
    log.summary ||
    (useFirstPrompt ? strippedFirstPrompt : undefined) ||
    defaultTitle ||
    (isAutonomousPrompt ? 'Autonomous session' : undefined) ||
    (log.sessionId ? log.sessionId.slice(0, 8) : '') ||
    ''
  return stripDisplayTags(title).trim()
}

export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

const MAX_IN_MEMORY_ERRORS = 100
let inMemoryErrorLog: Array<{ error: string; timestamp: string }> = []

function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift()
  }
  inMemoryErrorLog.push(errorInfo)
}

export type ErrorLogSink = {
  logError: (error: Error) => void
  logMcpError: (serverName: string, error: unknown) => void
  logMcpDebug: (serverName: string, message: string) => void
  getErrorsPath: () => string
  getMcpLogsPath: (serverName: string) => string
}

type QueuedErrorEvent =
  | { type: 'error'; error: Error }
  | { type: 'mcpError'; serverName: string; error: unknown }
  | { type: 'mcpDebug'; serverName: string; message: string }

const errorQueue: QueuedErrorEvent[] = []
let errorLogSink: ErrorLogSink | null = null

/**
 * Attaches the error log sink and immediately drains queued events.
 * Idempotent: subsequent calls after attachment are no-ops.
 */
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (errorLogSink !== null) {
    return
  }
  errorLogSink = newSink

  if (errorQueue.length > 0) {
    const queuedEvents = [...errorQueue]
    errorQueue.length = 0

    for (const event of queuedEvents) {
      switch (event.type) {
        case 'error':
          errorLogSink.logError(event.error)
          break
        case 'mcpError':
          errorLogSink.logMcpError(event.serverName, event.error)
          break
        case 'mcpDebug':
          errorLogSink.logMcpDebug(event.serverName, event.message)
          break
      }
    }
  }
}

const isHardFailMode = memoize((): boolean => {
  return process.argv.includes('--hard-fail')
})

/**
 * Logs an error to the in-memory ring buffer and the attached error log sink.
 */
export function logError(error: unknown): void {
  const err = toError(error)
  if (isFeatureEnabled('HARD_FAIL') && isHardFailMode()) {
    console.error('[HARD FAIL] logError called with:', err.stack || err.message)
    process.exit(1)
  }
  try {
    if (
      isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK) ||
      isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX) ||
      isEnvTruthy(process.env.COPILOT_CLI_USE_FOUNDRY) ||
      process.env.DISABLE_ERROR_REPORTING ||
      isEssentialTrafficOnly()
    ) {
      return
    }

    const errorStr = err.stack || err.message
    addToInMemoryErrorLog({
      error: errorStr,
      timestamp: new Date().toISOString(),
    })

    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }

    errorLogSink.logError(err)
  } catch {
    // Silently ignore logging failures
  }
}

export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrorLog]
}

export function loadErrorLogs(): Promise<LogOption[]> {
  return loadLogList(CACHE_PATHS.errors())
}

export async function getErrorLogByIndex(
  index: number,
): Promise<LogOption | null> {
  const logs = await loadErrorLogs()
  return logs[index] || null
}

function parseIsoString(isoString: string): Date {
  const parts = isoString.split(/\D+/)
  return new Date(
    Date.UTC(
      parseInt(parts[0]!, 10),
      parseInt(parts[1]!, 10) - 1,
      parseInt(parts[2]!, 10),
      parseInt(parts[3]!, 10),
      parseInt(parts[4]!, 10),
      parseInt(parts[5]!, 10),
      parseInt(parts[6]!, 10),
    ),
  )
}

async function loadLogList(dirPath: string): Promise<LogOption[]> {
  let files: Dirent[]
  try {
    files = await readdir(dirPath, { withFileTypes: true })
  } catch {
    logError(new Error(`No logs found at ${dirPath}`))
    return []
  }
  const logData = await Promise.all(
    files.map(async (file, index) => {
      const fullPath = join(dirPath, String(file.name))
      const content = await readFile(fullPath, { encoding: 'utf8' })
      const messages = jsonParse(content) as SerializedMessage[]
      const firstMessage = messages[0]
      const lastMessage = messages[messages.length - 1]
      const firstPrompt =
        firstMessage?.type === 'user' &&
        typeof firstMessage?.message?.content === 'string'
          ? firstMessage.message.content
          : 'No prompt'

      const fileStats = await stat(fullPath)
      const isSidechain = fullPath.includes('sidechain')
      const date = dateToFilename(fileStats.mtime)

      return {
        date,
        fullPath,
        messages,
        value: index,
        created: parseIsoString(firstMessage?.timestamp || date),
        modified: lastMessage?.timestamp
          ? parseIsoString(lastMessage.timestamp)
          : parseIsoString(date),
        firstPrompt:
          firstPrompt.split('\n')[0]?.slice(0, 50) +
            (firstPrompt.length > 50 ? '…' : '') || 'No prompt',
        messageCount: messages.length,
        isSidechain,
      }
    }),
  )

  return sortLogs(logData.filter(entry => entry !== null)).map(
    (entry, index) => ({
      ...entry,
      value: index,
    }),
  )
}

export function logMcpError(serverName: string, error: unknown): void {
  try {
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpError', serverName, error })
      return
    }
    errorLogSink.logMcpError(serverName, error)
  } catch {
    // Silently fail
  }
}

export function logMcpDebug(serverName: string, message: string): void {
  try {
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpDebug', serverName, message })
      return
    }
    errorLogSink.logMcpDebug(serverName, message)
  } catch {
    // Silently fail
  }
}

/**
 * Captures the last API request (excluding messages) for diagnostics and bug reports.
 */
export function captureApiRequest(
  params: BetaMessageStreamParams,
  querySource?: QuerySource,
): void {
  if (!querySource || !querySource.startsWith('repl_main_thread')) {
    return
  }

  const { messages: _messages, ...paramsWithoutMessages } = params
  setLastApiRequest(paramsWithoutMessages)
  setLastApiRequestMessages(null)
}

/**
 * Resets error log state for testing purposes only.
 */
export function resetErrorLogForTesting(): void {
  errorLogSink = null
  errorQueue.length = 0
  inMemoryErrorLog = []
}
