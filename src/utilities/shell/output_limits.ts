/**
 * Output length bounds for shell tool execution (`Bash` / `PowerShell`).
 */

import { validateBoundedIntEnvVar } from '../env_validation.js'

export const BASH_MAX_OUTPUT_DEFAULT = 30_000
export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000

/**
 * Resolves the active maximum inline shell output length (default 30,000 chars,
 * configurable via `BASH_MAX_OUTPUT_LENGTH`, capped at 150,000 chars).
 */
export function getMaxOutputLength(): number {
  return validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  ).effective
}
