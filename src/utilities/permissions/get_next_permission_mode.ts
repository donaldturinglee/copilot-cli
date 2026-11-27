/**
 * Deterministic permission mode cycling for Shift+Tab / interactive mode switches.
 */

import type { PermissionMode } from '../../types/permissions.js'
import { isAutoModeAvailable } from './auto_mode_state.js'
import { isBypassPermissionsDisabled } from './bypass_permissions_killswitch.js'

export interface NextPermissionModeOptions {
  isBypassPermissionsModeAvailable?: boolean
  isAutoModeEnabled?: boolean
}

/**
 * Returns the next permission mode in the interactive cycle.
 */
export function getNextPermissionMode(
  currentMode: PermissionMode,
  options: NextPermissionModeOptions = {},
): PermissionMode {
  const bypassAvailable =
    Boolean(options.isBypassPermissionsModeAvailable) &&
    !isBypassPermissionsDisabled()
  const autoAvailable =
    options.isAutoModeEnabled ?? isAutoModeAvailable()

  const cycle: PermissionMode[] = ['default', 'acceptEdits', 'plan']
  if (autoAvailable) {
    cycle.push('auto')
  }
  if (bypassAvailable) {
    cycle.push('bypassPermissions')
  }

  const idx = cycle.indexOf(currentMode)
  if (idx === -1) {
    return 'default'
  }
  return cycle[(idx + 1) % cycle.length]!
}
