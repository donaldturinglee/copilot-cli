/**
 * Worktree isolation capability check.
 */

import { isEnvTruthy } from './env_utils.js'

export function isWorktreeModeEnabled(): boolean {
  return !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_WORKTREE)
}
