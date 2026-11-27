/**
 * Shared shell tool predicates (`Bash` / `PowerShell`).
 */

import { BASH_TOOL_NAME, POWERSHELL_TOOL_NAME } from '../../constants/tools.js'
import { isEnvTruthy } from '../env_utils.js'
import { getPlatform } from '../platform.js'

export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
])

/**
 * Returns true if `PowerShellTool` should be enabled in the active environment.
 * Enabled automatically on Windows (unless explicitly disabled) or when
 * `COPILOT_CLI_USE_POWERSHELL_TOOL` is truthy.
 */
export function isPowerShellToolEnabled(): boolean {
  const envVal = process.env.COPILOT_CLI_USE_POWERSHELL_TOOL
  if (envVal !== undefined) {
    return isEnvTruthy(envVal)
  }
  return getPlatform() === 'windows'
}

/**
 * Returns true if background shell task execution is disabled via env var.
 */
export function isBackgroundTasksDisabled(): boolean {
  return isEnvTruthy(process.env.COPILOT_CLI_DISABLE_BACKGROUND_TASKS)
}
