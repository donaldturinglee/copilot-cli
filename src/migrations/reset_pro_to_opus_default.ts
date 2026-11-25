import { logEvent } from '../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getMigrationHooks } from './migration_hooks.js'

/**
 * One-shot migration recording Pro first-party default upgrade to Opus.
 */
export function resetProToOpusDefault(): void {
  const config = getGlobalConfig()
  if (config.opusProMigrationComplete) {
    return
  }

  const hooks = getMigrationHooks()
  if (hooks.getApiProvider() !== 'firstParty' || !hooks.isProSubscriber()) {
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
    }))
    logEvent('tengu_reset_pro_to_opus_default', { skipped: true })
    return
  }

  const settings = getInitialSettings()
  if (settings?.model === undefined) {
    const opusProMigrationTimestamp = Date.now()
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
      opusProMigrationTimestamp,
    }))
    logEvent('tengu_reset_pro_to_opus_default', {
      skipped: false,
      had_custom_model: false,
    })
  } else {
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
    }))
    logEvent('tengu_reset_pro_to_opus_default', {
      skipped: false,
      had_custom_model: true,
    })
  }
}
