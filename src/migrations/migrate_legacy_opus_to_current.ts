import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import { saveGlobalConfig } from '../utilities/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utilities/settings/settings.js'
import { getMigrationHooks } from './migration_hooks.js'

const LEGACY_OPUS_MODELS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

/**
 * Migrates first-party users off explicit Opus 4.0/4.1 strings in `userSettings` to `'opus'`.
 */
export function migrateLegacyOpusToCurrent(): void {
  const hooks = getMigrationHooks()
  if (hooks.getApiProvider() !== 'firstParty') {
    return
  }
  if (!hooks.isLegacyModelRemapEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (!model || !LEGACY_OPUS_MODELS.has(model)) {
    return
  }

  updateSettingsForSource('userSettings', { model: 'opus' })
  saveGlobalConfig(current => ({
    ...current,
    legacyOpusMigrationTimestamp: Date.now(),
  }))
  logEvent('tengu_legacy_opus_migration', {
    from_model: model as VerifiedNonSensitiveAnalyticsMetadata,
  })
}
