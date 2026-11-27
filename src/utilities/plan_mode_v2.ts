/**
 * Plan mode v2 feature flags.
 */

import { isEnvTruthy } from './env_utils.js'

export function isPlanModeInterviewPhaseEnabled(): boolean {
  return !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_PLAN_INTERVIEW)
}
