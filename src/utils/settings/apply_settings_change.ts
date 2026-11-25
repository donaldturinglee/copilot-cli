import type { AppState } from '../../state/app_state_store.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

type SettingsChangePostProcessor = (
  source: SettingSource,
  setAppState: (updater: (prev: AppState) => AppState) => void,
) => void

const postProcessors = new Set<SettingsChangePostProcessor>()

/**
 * Registers downstream Phase 4 permission/hook reload handlers invoked on
 * settings file changes without introducing backward imports.
 */
export function registerSettingsChangePostProcessor(
  processor: SettingsChangePostProcessor,
): () => void {
  postProcessors.add(processor)
  return () => {
    postProcessors.delete(processor)
  }
}

export function applySettingsChange(
  source: SettingSource,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  setAppState(prev => {
    const effortChanged =
      prev.settings.effortLevel !== newSettings.effortLevel &&
      newSettings.effortLevel !== undefined

    return {
      ...prev,
      settings: newSettings,
      ...(effortChanged ? { effortValue: newSettings.effortLevel } : {}),
    }
  })

  for (const processor of postProcessors) {
    processor(source, setAppState)
  }
}
