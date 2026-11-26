/**
 * Suggests upgrading to 1M-context models when the user is on a 200k default
 * model with 1M access enabled.
 */

import { checkOpus1mAccess, checkSonnet1mAccess } from './check_1m_access.js'
import { getUserSpecifiedModelSetting } from './model.js'

/**
 * Returns an upgrade hint string when the user can switch to a 5x 1M-context
 * model variant, or `null` otherwise.
 */
export function getUpgradeMessage(kind: 'warning' | 'tip'): string | null {
  const setting = getUserSpecifiedModelSetting()?.toLowerCase()
  if (setting === 'opus' && checkOpus1mAccess()) {
    return kind === 'warning'
      ? 'Tip: Run /model opus[1m] for 5x larger context window (1M tokens).'
      : 'Use /model opus[1m] to enable 1M context.'
  }
  if (setting === 'sonnet' && checkSonnet1mAccess()) {
    return kind === 'warning'
      ? 'Tip: Run /model sonnet[1m] for 5x larger context window (1M tokens).'
      : 'Use /model sonnet[1m] to enable 1M context.'
  }
  return null
}
