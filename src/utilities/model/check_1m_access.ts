/**
 * Checks whether the current account has access to 1M-context Opus / Sonnet models.
 */

import { isClaudeAiSubscriber } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import { is1mContextDisabled } from '../context.js'

function hasSubscriberExtraUsageAccess(): boolean {
  const reason = getGlobalConfig().cachedExtraUsageDisabledReason
  if (reason === undefined) {
    return false
  }
  return reason === null || reason === 'out_of_credits'
}

/**
 * Returns true if 1M context Opus access is available.
 */
export function checkOpus1mAccess(): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (!isClaudeAiSubscriber()) {
    return true
  }
  return hasSubscriberExtraUsageAccess()
}

/**
 * Returns true if 1M context Sonnet access is available.
 */
export function checkSonnet1mAccess(): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (!isClaudeAiSubscriber()) {
    return true
  }
  return hasSubscriberExtraUsageAccess()
}
