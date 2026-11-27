/**
 * Startup hook configuration snapshotting & enterprise policy enforcement
 * (`disableAllHooks`, `allowManagedHooksOnly`, `strictPluginOnlyCustomization`).
 *
 * Capturing the hooks config at startup prevents untrusted workspace edits made
 * mid-session from silently injecting new hooks until explicitly refreshed.
 */

import { resetSdkInitState } from '../../bootstrap/state.js'
import type { HooksSettings } from '../../schemas/hooks.js'
import { isRestrictedToPluginOnly } from '../settings/plugin_only_policy.js'
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settings_cache.js'

let initialHooksConfig: HooksSettings | null = null

function getHooksFromAllowedSources(): HooksSettings {
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  if (policySettings?.allowManagedHooksOnly === true) {
    return (policySettings.hooks as HooksSettings | undefined) ?? {}
  }

  if (isRestrictedToPluginOnly('hooks')) {
    return (policySettings?.hooks as HooksSettings | undefined) ?? {}
  }

  const mergedSettings = settingsModule.getSettings()
  if (mergedSettings.disableAllHooks === true) {
    // Non-managed disableAllHooks cannot disable managed policy hooks
    return (policySettings?.hooks as HooksSettings | undefined) ?? {}
  }

  return (mergedSettings.hooks as HooksSettings | undefined) ?? {}
}

export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  const merged = settingsModule.getSettings()
  if (
    merged.disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  return false
}

export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

export function updateHooksConfigSnapshot(): void {
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null
  resetSdkInitState()
}
