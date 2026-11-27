/**
 * Timeout defaults and configuration limits for shell tools.
 */

import { validateBoundedIntEnvVar } from './env_validation.js'

export const DEFAULT_BASH_TIMEOUT_MS = 120_000
export const MAX_BASH_TIMEOUT_MS = 600_000

export function getDefaultBashTimeoutMs(): number {
  return validateBoundedIntEnvVar(
    'BASH_DEFAULT_TIMEOUT_MS',
    process.env.BASH_DEFAULT_TIMEOUT_MS,
    DEFAULT_BASH_TIMEOUT_MS,
    MAX_BASH_TIMEOUT_MS,
  ).effective
}

export function getMaxBashTimeoutMs(): number {
  return validateBoundedIntEnvVar(
    'BASH_MAX_TIMEOUT_MS',
    process.env.BASH_MAX_TIMEOUT_MS,
    MAX_BASH_TIMEOUT_MS,
    3_600_000,
  ).effective
}
