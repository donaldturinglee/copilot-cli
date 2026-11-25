import { dirname } from 'path'
import { getFsImplementation } from './fs_operations.js'
import { jsonStringify } from './slow_operations.js'

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'

type DiagnosticLogEntry = {
  timestamp: string
  level: DiagnosticLogLevel
  event: string
  data: Record<string, unknown>
}

function getDiagnosticLogFile(): string | undefined {
  return process.env.COPILOT_CLI_DIAGNOSTICS_FILE
}

/**
 * Logs non-PII diagnostic information to the configured diagnostics logfile.
 * Callers must not pass PII such as file paths, repo names, or prompts.
 */
export function logForDiagnosticsNoPii(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const logFile = getDiagnosticLogFile()
  if (!logFile) {
    return
  }

  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    data: data ?? {},
  }

  const fsImpl = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fsImpl.appendFileSync(logFile, line)
  } catch {
    try {
      fsImpl.mkdirSync(dirname(logFile))
      fsImpl.appendFileSync(logFile, line)
    } catch {
      // Silently fail if logging is unavailable
    }
  }
}

/**
 * Wraps an async function with start/complete/failure diagnostic timing logs.
 */
export async function withDiagnosticsTiming<Result>(
  event: string,
  fn: () => Promise<Result>,
  getData?: (result: Result) => Record<string, unknown>,
): Promise<Result> {
  const startTime = Date.now()
  logForDiagnosticsNoPii('info', `${event}_started`)

  try {
    const result = await fn()
    const additionalData = getData ? getData(result) : {}
    logForDiagnosticsNoPii('info', `${event}_completed`, {
      duration_ms: Date.now() - startTime,
      ...additionalData,
    })
    return result
  } catch (error) {
    logForDiagnosticsNoPii('error', `${event}_failed`, {
      duration_ms: Date.now() - startTime,
    })
    throw error
  }
}
