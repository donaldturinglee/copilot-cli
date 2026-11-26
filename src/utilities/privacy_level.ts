/**
 * Privacy and telemetry level resolution from environment variables.
 */

import { isEnvTruthy } from './env_utils.js'

export type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

/**
 * Resolves the active privacy level.
 * Precedence: COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC > DISABLE_TELEMETRY > default.
 */
export function getPrivacyLevel(): PrivacyLevel {
  if (isEnvTruthy(process.env.COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return 'essential-traffic'
  }
  if (isEnvTruthy(process.env.DISABLE_TELEMETRY)) {
    return 'no-telemetry'
  }
  return 'default'
}

/**
 * Returns true when non-essential background network traffic must be skipped.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
 * Returns true when telemetry reporting is disabled.
 */
export function isTelemetryDisabled(): boolean {
  const level = getPrivacyLevel()
  return level === 'no-telemetry' || level === 'essential-traffic'
}

/**
 * Returns the environment variable name forcing essential-traffic-only mode, if any.
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (isEnvTruthy(process.env.COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return 'COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  return null
}
