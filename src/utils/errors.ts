import { APIUserAbortError } from '@anthropic-ai/sdk'

export class ClaudeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class MalformedCommandError extends Error {}

export class AbortError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AbortError'
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortError ||
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export class ConfigParseError extends Error {
  filePath: string
  defaultConfig: unknown

  constructor(message: string, filePath: string, defaultConfig: unknown) {
    super(message)
    this.name = 'ConfigParseError'
    this.filePath = filePath
    this.defaultConfig = defaultConfig
  }
}

export class ShellError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number,
    public readonly interrupted: boolean,
  ) {
    super('Shell command failed')
    this.name = 'ShellError'
  }
}

export class TeleportOperationError extends Error {
  constructor(
    message: string,
    public readonly formattedMessage: string,
  ) {
    super(message)
    this.name = 'TeleportOperationError'
  }
}

export class TelemetrySafeError extends Error {
  readonly telemetryMessage: string

  constructor(message: string, telemetryMessage?: string) {
    super(message)
    this.name = 'TelemetrySafeError'
    this.telemetryMessage = telemetryMessage ?? message
  }
}

export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getErrnoCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code
  }
  return undefined
}

export function isEnoent(error: unknown): boolean {
  return getErrnoCode(error) === 'ENOENT'
}

export function getErrnoPath(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'path' in error &&
    typeof error.path === 'string'
  ) {
    return error.path
  }
  return undefined
}

export function shortErrorStack(error: unknown, maxFrames = 5): string {
  if (!(error instanceof Error)) return String(error)
  if (!error.stack) return error.message
  const lines = error.stack.split('\n')
  const header = lines[0] ?? error.message
  const frames = lines.slice(1).filter(line => line.trim().startsWith('at '))
  if (frames.length <= maxFrames) return error.stack
  return [header, ...frames.slice(0, maxFrames)].join('\n')
}

export function isFsInaccessible(error: unknown): error is NodeJS.ErrnoException {
  const code = getErrnoCode(error)
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  )
}

export type AxiosErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'other'

export function classifyAxiosError(error: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  const message = errorMessage(error)
  if (
    !error ||
    typeof error !== 'object' ||
    !('isAxiosError' in error) ||
    !error.isAxiosError
  ) {
    return { kind: 'other', message }
  }
  const axiosError = error as {
    response?: { status?: number }
    code?: string
  }
  const status = axiosError.response?.status
  if (status === 401 || status === 403) return { kind: 'auth', status, message }
  if (axiosError.code === 'ECONNABORTED') {
    return { kind: 'timeout', status, message }
  }
  if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND') {
    return { kind: 'network', status, message }
  }
  return { kind: 'http', status, message }
}
