import { logEvent } from '../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utilities/config.js'
import { isFeatureEnabled } from '../utilities/feature_flags.js'
import { logError } from '../utilities/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utilities/settings/settings.js'
import { getMigrationHooks } from './migration_hooks.js'

/**
 * One-shot migration clearing `skipAutoPermissionPrompt` when auto mode is enabled
 * so users see the updated default-mode offer.
 */
export function resetAutoModeOptInForDefaultOffer(): void {
  if (!isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    return
  }

  const config = getGlobalConfig()
  if (config.hasResetAutoModeOptInForDefaultOffer) {
    return
  }
  if (getMigrationHooks().getAutoModeEnabledState() !== 'enabled') {
    return
  }

  try {
    const userSettings = getSettingsForSource('userSettings')
    const defaultMode: string | undefined = userSettings?.permissions?.defaultMode
    if (
      userSettings?.skipAutoPermissionPrompt &&
      defaultMode !== 'auto'
    ) {
      updateSettingsForSource('userSettings', {
        skipAutoPermissionPrompt: undefined,
      })
      logEvent('tengu_migrate_reset_auto_opt_in_for_default_offer', {})
    }

    saveGlobalConfig(current => {
      if (current.hasResetAutoModeOptInForDefaultOffer) return current
      return { ...current, hasResetAutoModeOptInForDefaultOffer: true }
    })
  } catch (error) {
    logError(new Error(`Failed to reset auto mode opt-in: ${error}`))
  }
}
