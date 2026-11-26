import { logEvent } from '../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utilities/config.js'
import { logError } from '../utilities/log.js'
import {
  hasSkipDangerousModePermissionPrompt,
  updateSettingsForSource,
} from '../utilities/settings/settings.js'

/**
 * Migrates `bypassPermissionsModeAccepted` from global config to
 * `userSettings.skipDangerousModePermissionPrompt`.
 */
export function migrateBypassPermissionsAcceptedToSettings(): void {
  const globalConfig = getGlobalConfig()

  if (!globalConfig.bypassPermissionsModeAccepted) {
    return
  }

  try {
    if (!hasSkipDangerousModePermissionPrompt()) {
      updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true,
      })
    }

    logEvent('tengu_migrate_bypass_permissions_accepted', {})

    saveGlobalConfig(current => {
      if (!('bypassPermissionsModeAccepted' in current)) return current
      const updated = { ...current }
      delete updated.bypassPermissionsModeAccepted
      return updated
    })
  } catch (error) {
    logError(
      new Error(`Failed to migrate bypass permissions accepted: ${error}`),
    )
  }
}
