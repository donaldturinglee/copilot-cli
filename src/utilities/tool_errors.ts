/**
 * Structured error formatting helpers for tool execution and Zod schema
 * validation failures.
 */

import type { ZodError } from 'zod/v4'

/**
 * Formats an unknown thrown value into a concise diagnostic string.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Splits an error into its name, message, and optional errno code for telemetry
 * and structured error rendering.
 */
export function getErrorParts(error: unknown): {
  name: string
  message: string
  code?: string
} {
  if (error instanceof Error) {
    const code =
      'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined
    return {
      name: error.name || 'Error',
      message: error.message || error.name || 'Unknown error',
      ...(code ? { code } : {}),
    }
  }
  return {
    name: 'Error',
    message: formatError(error),
  }
}

/**
 * Formats a Zod validation error into a clear, actionable message for the model
 * listing missing, unexpected, or invalid parameter paths.
 */
export function formatZodValidationError(
  toolName: string,
  error: ZodError,
): string {
  const issues = error.issues
  if (issues.length === 0) {
    return `InputValidationError: Invalid parameters for tool \`${toolName}\`: ${error.message}`
  }

  const lines = issues.map(issue => {
    const pathStr = issue.path.length > 0 ? issue.path.join('.') : '<root>'
    return `  - ${pathStr}: ${issue.message}`
  })

  return `InputValidationError: \`${toolName}\` failed due to the following issue${issues.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}
