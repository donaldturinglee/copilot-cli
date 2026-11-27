import { isEnvDefinedFalsy, isEnvTruthy } from './env_utils.js'

let fullscreenOverride: boolean | null = null

/**
 * Whether fullscreen (Alt-Screen DEC 1049) mode is enabled via environment
 * variables (`COPILOT_CLI_NO_FLICKER` / `COPILOT_CLI_FULLSCREEN`).
 */
export function isFullscreenEnvEnabled(): boolean {
  if (fullscreenOverride !== null) {
    return fullscreenOverride
  }
  if (
    isEnvDefinedFalsy(process.env.COPILOT_CLI_NO_FLICKER) ||
    isEnvDefinedFalsy(process.env.COPILOT_CLI_FULLSCREEN)
  ) {
    return false
  }
  return (
    isEnvTruthy(process.env.COPILOT_CLI_NO_FLICKER) ||
    isEnvTruthy(process.env.COPILOT_CLI_FULLSCREEN)
  )
}

export function setFullscreenOverrideForTesting(value: boolean | null): void {
  fullscreenOverride = value
}
