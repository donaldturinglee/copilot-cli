import { type ExecaError, execa } from 'execa'
import { getCwd } from './cwd.js'
import { logError } from './log.js'

export { execSyncWithDefaultsDeprecated } from './exec_file_no_throw_portable.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  })
}

type ExecFileWithCwdOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean | string | undefined
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

type ExecaResultWithError = {
  shortMessage?: string
  signal?: string
}

function getErrorMessage(
  result: ExecaResultWithError,
  errorCode: number,
): string {
  if (result.shortMessage) {
    return result.shortMessage
  }
  if (typeof result.signal === 'string') {
    return result.signal
  }
  return String(errorCode)
}

/**
 * Executes a file via execa, always resolving without throwing on non-zero exit codes.
 */
export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer,
    shell,
    stdin: finalStdin,
    input: finalInput,
  }: ExecFileWithCwdOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise(resolve => {
    execa(file, args, {
      maxBuffer,
      cancelSignal: abortSignal,
      timeout: finalTimeout,
      cwd: finalCwd,
      env: finalEnv,
      shell,
      stdin: finalStdin,
      input: finalInput,
      reject: false,
    })
      .then(result => {
        const stdout =
          typeof result.stdout === 'string'
            ? result.stdout
            : String(result.stdout ?? '')
        const stderr =
          typeof result.stderr === 'string'
            ? result.stderr
            : String(result.stderr ?? '')
        if (result.failed) {
          if (finalPreserveOutput) {
            const errorCode = result.exitCode ?? 1
            resolve({
              stdout,
              stderr,
              code: errorCode,
              error: getErrorMessage(
                result as unknown as ExecaResultWithError,
                errorCode,
              ),
            })
          } else {
            resolve({ stdout: '', stderr: '', code: result.exitCode ?? 1 })
          }
        } else {
          resolve({
            stdout,
            stderr,
            code: 0,
          })
        }
      })
      .catch((error: ExecaError) => {
        logError(error)
        resolve({ stdout: '', stderr: '', code: 1 })
      })
  })
}
