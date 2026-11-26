import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utilities/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utilities/settings/settings.js'
import { getMigrationHooks } from './migration_hooks.js'

const SONNET_45_MODELS = new Set([
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5-20250929[1m]',
  'sonnet-4-5-20250929',
  'sonnet-4-5-20250929[1m]',
])

/**
 * Migrates first-party Pro/Max/Team Premium subscribers off explicit Sonnet 4.5
 * strings in `userSettings` to the `'sonnet'` / `'sonnet[1m]'` alias.
 */
export function migrateSonnet45ToSonnet46(): void {
  const hooks = getMigrationHooks()
  if (hooks.getApiProvider() !== 'firstParty') {
    return
  }

  if (
    !hooks.isProSubscriber() &&
    !hooks.isMaxSubscriber() &&
    !hooks.isTeamPremiumSubscriber()
  ) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (!model || !SONNET_45_MODELS.has(model)) {
    return
  }

  const has1m = model.endsWith('[1m]')
  updateSettingsForSource('userSettings', {
    model: has1m ? 'sonnet[1m]' : 'sonnet',
  })

  const config = getGlobalConfig()
  if (config.numStartups > 1) {
    saveGlobalConfig(current => ({
      ...current,
      sonnet45To46MigrationTimestamp: Date.now(),
    }))
  }

  logEvent('tengu_sonnet45_to_46_migration', {
    from_model: model as VerifiedNonSensitiveAnalyticsMetadata,
    has_1m: has1m,
  })
}
