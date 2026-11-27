/**
 * Accessors for hook-related settings and policy gates.
 */

import * as settingsModule from '../settings/settings.js'

export function getHttpHookAllowedUrls(): string[] | undefined {
  return settingsModule.getSettings().allowedHttpHookUrls
}

export function getHttpHookAllowedEnvVars(): string[] | undefined {
  return settingsModule.getSettings().httpHookAllowedEnvVars
}

export function isHooksDisabledBySettings(): boolean {
  const policy = settingsModule.getSettingsForSource('policySettings')
  if (policy?.disableAllHooks === true) return true
  return settingsModule.getSettings().disableAllHooks === true
}
