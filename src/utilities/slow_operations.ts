import type { WriteFileOptions } from 'fs'
import {
  closeSync,
  writeFileSync as fsWriteFileSync,
  fsyncSync,
  openSync,
} from 'fs'
import lodashCloneDeep from 'lodash-es/cloneDeep.js'
import { addSlowOperation } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isFeatureEnabled } from './feature_flags.js'

type WriteFileOptionsWithFlush =
  | WriteFileOptions
  | (WriteFileOptions & { flush?: boolean })

/**
 * Threshold in milliseconds for logging slow JSON/clone/sync I/O operations.
 * Override with `COPILOT_CLI_SLOW_OPERATION_THRESHOLD_MS`.
 */
export const SLOW_OPERATION_THRESHOLD_MS = (() => {
  const envValue = process.env.COPILOT_CLI_SLOW_OPERATION_THRESHOLD_MS
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
  }
  if (process.env.NODE_ENV === 'development') {
    return 20
  }
  return Infinity
})()

let isLogging = false

/**
 * Extracts the first stack frame outside slow_operations.ts.
 */
export function callerFrame(stack: string | undefined): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    if (line.includes('slow_operations')) continue
    const match = line.match(/([^/\\]+?):(\d+):\d+\)?$/)
    if (match) return ` @ ${match[1]}:${match[2]}`
  }
  return ''
}

function buildDescription(
  strings: TemplateStringsArray,
  values: unknown[],
): string {
  let result = ''
  for (let i = 0; i < strings.length; i++) {
    result += strings[i]
    if (i < values.length) {
      const value = values[i]
      if (Array.isArray(value)) {
        result += `Array[${value.length}]`
      } else if (value !== null && typeof value === 'object') {
        result += `Object{${Object.keys(value as Record<string, unknown>).length} keys}`
      } else if (typeof value === 'string') {
        result += value.length > 80 ? `${value.slice(0, 80)}…` : value
      } else {
        result += String(value)
      }
    }
  }
  return result
}

class SlowOperationLogger implements Disposable {
  private readonly startTime: number
  private readonly strings: TemplateStringsArray
  private readonly values: unknown[]
  private readonly errorStackHolder: Error

  constructor(strings: TemplateStringsArray, values: unknown[]) {
    this.startTime = performance.now()
    this.strings = strings
    this.values = values
    this.errorStackHolder = new Error()
  }

  [Symbol.dispose](): void {
    const duration = performance.now() - this.startTime
    if (duration > SLOW_OPERATION_THRESHOLD_MS && !isLogging) {
      isLogging = true
      try {
        const description =
          buildDescription(this.strings, this.values) +
          callerFrame(this.errorStackHolder.stack)
        logForDebugging(
          `[SLOW OPERATION DETECTED] ${description} (${duration.toFixed(1)}ms)`,
        )
        addSlowOperation(description, duration)
      } finally {
        isLogging = false
      }
    }
  }
}

const NOOP_LOGGER: Disposable = { [Symbol.dispose]() {} }

/**
 * Tagged template returning a Disposable that times the surrounding scope
 * when `SLOW_OPERATION_LOGGING` is enabled.
 */
export function slowLogging(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Disposable {
  if (!isFeatureEnabled('SLOW_OPERATION_LOGGING')) {
    return NOOP_LOGGER
  }
  return new SlowOperationLogger(strings, values)
}

export function jsonStringify(
  value: unknown,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: (number | string)[] | null,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?:
    | ((this: unknown, key: string, value: unknown) => unknown)
    | (number | string)[]
    | null,
  space?: string | number,
): string {
  using slowOp = slowLogging`JSON.stringify(${value})`
  void slowOp
  return JSON.stringify(
    value,
    replacer as Parameters<typeof JSON.stringify>[1],
    space,
  )
}

export const jsonParse: typeof JSON.parse = (text, reviver) => {
  using slowOp = slowLogging`JSON.parse(${text})`
  void slowOp
  return typeof reviver === 'undefined'
    ? JSON.parse(text)
    : JSON.parse(text, reviver)
}

export function clone<Value>(
  value: Value,
  options?: StructuredSerializeOptions,
): Value {
  using slowOp = slowLogging`structuredClone(${value})`
  void slowOp
  return structuredClone(value, options)
}

export function cloneDeep<Value>(value: Value): Value {
  using slowOp = slowLogging`cloneDeep(${value})`
  void slowOp
  return lodashCloneDeep(value)
}

/**
 * Wrapper around fs.writeFileSync with slow operation logging and flush support.
 *
 * @deprecated Use `fs.promises.writeFile` for non-blocking writes.
 */
export function writeFileSyncDeprecated(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileOptionsWithFlush,
): void {
  using slowOp = slowLogging`fs.writeFileSync(${filePath}, ${data})`
  void slowOp

  const needsFlush =
    options !== null &&
    typeof options === 'object' &&
    'flush' in options &&
    options.flush === true

  if (needsFlush) {
    const encoding =
      typeof options === 'object' && 'encoding' in options
        ? options.encoding
        : undefined
    const mode =
      typeof options === 'object' && 'mode' in options
        ? options.mode
        : undefined
    let fd: number | undefined
    try {
      fd = openSync(filePath, 'w', mode)
      fsWriteFileSync(fd, data, { encoding: encoding ?? undefined })
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  } else {
    fsWriteFileSync(filePath, data, options as WriteFileOptions)
  }
}
