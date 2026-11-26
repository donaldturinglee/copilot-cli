import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utilities/settings/settings.js'

/**
 * Migrates removed fennec / opus-4-5-fast aliases in `userSettings` to current Opus aliases.
 */
export function migrateFennecToOpus(): void {
  const settings = getSettingsForSource('userSettings')
  const model = settings?.model
  if (typeof model !== 'string') {
    return
  }

  if (model.startsWith('fennec-latest[1m]')) {
    updateSettingsForSource('userSettings', { model: 'opus[1m]' })
  } else if (model.startsWith('fennec-latest')) {
    updateSettingsForSource('userSettings', { model: 'opus' })
  } else if (
    model.startsWith('fennec-fast-latest') ||
    model.startsWith('opus-4-5-fast')
  ) {
    updateSettingsForSource('userSettings', {
      model: 'opus[1m]',
      fastMode: true,
    })
  }
}
