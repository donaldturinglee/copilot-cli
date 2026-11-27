/**
 * Session-scoped latch tracking whether `auto` classifier mode is active
 * or explicitly disabled by policy/settings.
 */

import { isFeatureEnabled } from '../feature_flags.js'
import * as settingsModule from '../settings/settings.js'

let autoModeSessionActive = false

export function isAutoModeActive(): boolean {
  return autoModeSessionActive
}

export function setAutoModeActive(active: boolean): void {
  autoModeSessionActive = active
}

export function isAutoModeDisabledByPolicy(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.disableAutoMode === 'disable') {
    return true
  }
  const merged = settingsModule.getSettings()
  return merged.disableAutoMode === 'disable'
}

export function isAutoModeAvailable(): boolean {
  if (isAutoModeDisabledByPolicy()) {
    return false
  }
  return (
    isFeatureEnabled('TRANSCRIPT_CLASSIFIER') ||
    settingsModule.hasAutoModeOptIn()
  )
}

export function resetAutoModeStateForTesting(): void {
  autoModeSessionActive = false
}
