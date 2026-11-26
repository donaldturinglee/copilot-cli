/**
 * Determines whether a Claude.ai subscriber request is billed as extra usage.
 */

import { isClaudeAiSubscriber } from './auth.js'
import { has1mContext } from './context.js'

/**
 * Returns true if the selected model / fast-mode configuration bills as extra
 * usage on a Claude.ai subscription.
 */
export function isBilledAsExtraUsage(
  model: string | null,
  isFastMode: boolean,
  isOpus1mMerged: boolean,
): boolean {
  if (!isClaudeAiSubscriber()) {
    return false
  }
  if (isFastMode) {
    return true
  }
  if (model === null || !has1mContext(model)) {
    return false
  }
  const base = model.replace(/\[1m\]/gi, '').trim().toLowerCase()
  const isOpus46 = base === 'opus' || base.includes('opus-4-6')
  const isSonnet46 = base === 'sonnet' || base.includes('sonnet-4-6')
  if (isOpus46 && isOpus1mMerged) {
    return false
  }
  return isOpus46 || isSonnet46
}
