import { type SyncOptions as ExecaSyncOptions, execaSync } from 'execa'
import { getCwd } from './cwd.js'
import { slowLogging } from './slow_operations.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60

type ExecSyncOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  input?: string
  stdio?: ExecaSyncOptions['stdio']
}

/**
 * Synchronous shell command execution with default timeout and maxBuffer.
 *
 * @deprecated Use `execa` directly with `{ shell: true, reject: false }` for non-blocking execution.
 */
export function execSyncWithDefaultsDeprecated(command: string): string | null
export function execSyncWithDefaultsDeprecated(
  command: string,
  options: ExecSyncOptions,
): string | null
export function execSyncWithDefaultsDeprecated(
  command: string,
  abortSignal: AbortSignal,
  timeout?: number,
): string | null
export function execSyncWithDefaultsDeprecated(
  command: string,
  optionsOrAbortSignal?: ExecSyncOptions | AbortSignal,
  timeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
): string | null {
  let options: ExecSyncOptions

  if (optionsOrAbortSignal === undefined) {
    options = {}
  } else if (optionsOrAbortSignal instanceof AbortSignal) {
    options = {
      abortSignal: optionsOrAbortSignal,
      timeout,
    }
  } else {
    options = optionsOrAbortSignal
  }

  const {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    input,
    stdio = ['ignore', 'pipe', 'pipe'],
  } = options

  abortSignal?.throwIfAborted()
  using slowOp = slowLogging`exec: ${command.slice(0, 200)}`
  void slowOp
  try {
    const result = execaSync(command, {
      env: process.env,
      maxBuffer: 1_000_000,
      timeout: finalTimeout,
      cwd: getCwd(),
      stdio,
      shell: true,
      reject: false,
      input,
    })
    if (!result.stdout) {
      return null
    }
    return String(result.stdout).trim() || null
  } catch {
    return null
  }
}
