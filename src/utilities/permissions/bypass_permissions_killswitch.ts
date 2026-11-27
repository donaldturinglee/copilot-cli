/**
 * Policy killswitch for `bypassPermissions` mode (`disableBypassPermissionsMode`).
 */

import * as settingsModule from '../settings/settings.js'

/**
 * Returns true when policy or merged settings explicitly disable
 * `bypassPermissions` mode via `permissions.disableBypassPermissionsMode: 'disable'`.
 */
export function isBypassPermissionsDisabled(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.permissions?.disableBypassPermissionsMode === 'disable') {
    return true
  }
  const merged = settingsModule.getSettings()
  return merged.permissions?.disableBypassPermissionsMode === 'disable'
}
