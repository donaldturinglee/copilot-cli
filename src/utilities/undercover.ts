/**
 * Undercover mode safety utilities (active only in internal `USER_TYPE === 'ant'`
 * builds when contributing to non-internal/public repositories).
 */

import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './env_utils.js'

export type RepoClass = 'internal' | 'external' | 'none' | null

let repoClassProvider: () => RepoClass = () => null

/**
 * Registers the repository classification provider (wired by commitAttribution
 * in Phase 7 or tests).
 */
export function registerRepoClassProvider(provider: () => RepoClass): void {
  repoClassProvider = provider
}

/**
 * Returns true if undercover mode is active (always `false` in external builds).
 */
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.COPILOT_CLI_UNDERCOVER)) {
      return true
    }
    return repoClassProvider() !== 'internal'
  }
  return false
}

/**
 * Returns undercover commit/PR safety instructions for ant builds, or `''`.
 */
export function getUndercoverInstructions(): string {
  if (process.env.USER_TYPE === 'ant') {
    return (
      '## UNDERCOVER MODE — CRITICAL\n\n' +
      'You are operating UNDERCOVER in a PUBLIC/OPEN-SOURCE repository. Your commit ' +
      'messages, PR titles, and PR bodies MUST NOT contain ANY internal information.\n' +
      'Write commit messages as a human developer would — describe only what the code change does.\n'
    )
  }
  return ''
}

/**
 * Returns true if the one-time auto-undercover notice should be displayed.
 */
export function shouldShowUndercoverAutoNotice(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.COPILOT_CLI_UNDERCOVER)) {
      return false
    }
    if (!isUndercover()) {
      return false
    }
    if (getGlobalConfig().hasSeenUndercoverAutoNotice) {
      return false
    }
    return true
  }
  return false
}
