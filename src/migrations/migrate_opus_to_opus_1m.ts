import { logEvent } from '../services/analytics/index.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { getMigrationHooks } from './migration_hooks.js'

/**
 * Migrates users pinned to `'opus'` in `userSettings` to `'opus[1m]'` (or clears
 * the explicit override if `'opus[1m]'` is already the resolved default).
 */
export function migrateOpusToOpus1m(): void {
  const hooks = getMigrationHooks()
  if (!hooks.isOpus1mMergeEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model !== 'opus') {
    return
  }

  const migrated = 'opus[1m]'
  const modelToSet =
    hooks.parseUserSpecifiedModel(migrated) ===
    hooks.parseUserSpecifiedModel(hooks.getDefaultMainLoopModelSetting())
      ? undefined
      : migrated

  updateSettingsForSource('userSettings', { model: modelToSet })
  logEvent('tengu_opus_to_opus1m_migration', {})
}
