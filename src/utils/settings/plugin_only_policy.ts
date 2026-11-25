import { getSettingsForSource } from './settings.js'
import type { CustomizationSurface } from './types.js'

export type { CustomizationSurface }

const ADMIN_TRUSTED_SOURCES = new Set([
  'plugin',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
])

export function isRestrictedToPluginOnly(
  surface: CustomizationSurface,
): boolean {
  const policy = getSettingsForSource('policySettings')
  const restriction = policy?.strictPluginOnlyCustomization
  if (restriction === true) {
    return true
  }
  if (Array.isArray(restriction)) {
    return restriction.includes(surface)
  }
  return false
}

export function isSourceAdminTrusted(source: string | undefined): boolean {
  return source !== undefined && ADMIN_TRUSTED_SOURCES.has(source)
}
