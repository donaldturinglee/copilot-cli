/**
 * Git instruction inclusion toggle (split from `git.ts` to avoid circular
 * `settings -> gitignore -> git -> settings` dependencies).
 */

import { isEnvDefinedFalsy, isEnvTruthy } from './env_utils.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * Returns true if git snapshot and workflow instructions should be included in
 * system context.
 */
export function shouldIncludeGitInstructions(): boolean {
  const envVal = process.env.COPILOT_CLI_DISABLE_GIT_INSTRUCTIONS
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  return getInitialSettings().includeGitInstructions ?? true
}
