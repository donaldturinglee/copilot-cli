/**
 * Loads layered permission rules (`allow`, `deny`, `ask`) and additional
 * working directories from all 6 settings tiers into a `ToolPermissionContext`,
 * respecting `allowManagedPermissionRulesOnly` and `disableBypassPermissionsMode`.
 */

import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionRuleSource,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from '../../types/permissions.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { expandPath } from '../path.js'
import * as settingsModule from '../settings/settings.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { isBypassPermissionsDisabled } from './bypass_permissions_killswitch.js'
import { stripDangerousAllowRulesForAutoMode } from './dangerous_patterns.js'

const SETTINGS_TO_RULE_SOURCES: readonly PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

export function isManagedPermissionRulesOnly(): boolean {
  const policy = settingsModule.getSettingsForSource('policySettings')
  return policy?.allowManagedPermissionRulesOnly === true
}

/**
 * Loads a fresh `ToolPermissionContext` from disk/cached settings across all
 * enabled setting sources.
 */
export function loadToolPermissionContextFromSettings(options?: {
  modeOverride?: PermissionMode
  allowedCliRules?: readonly string[]
  disallowedCliRules?: readonly string[]
  additionalDirectories?: readonly string[]
  shouldAvoidPermissionPrompts?: boolean
  isBypassPermissionsModeAvailable?: boolean
}): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  const managedOnly = isManagedPermissionRulesOnly()

  const alwaysAllowRules: ToolPermissionRulesBySource = {}
  const alwaysDenyRules: ToolPermissionRulesBySource = {}
  const alwaysAskRules: ToolPermissionRulesBySource = {}
  const additionalWorkingDirectories = new Map<
    string,
    AdditionalWorkingDirectory
  >()

  let defaultModeFromSettings: PermissionMode = 'default'

  for (const source of SETTING_SOURCES) {
    if (managedOnly && source !== 'policySettings') {
      continue
    }
    const settings = settingsModule.getSettingsForSource(source)
    if (!settings?.permissions) continue

    const ruleSource = source as PermissionRuleSource
    if (!SETTINGS_TO_RULE_SOURCES.includes(ruleSource)) continue

    if (settings.permissions.allow?.length) {
      alwaysAllowRules[ruleSource] = [...settings.permissions.allow]
    }
    if (settings.permissions.deny?.length) {
      alwaysDenyRules[ruleSource] = [...settings.permissions.deny]
    }
    if (settings.permissions.ask?.length) {
      alwaysAskRules[ruleSource] = [...settings.permissions.ask]
    }
    if (settings.permissions.defaultMode) {
      defaultModeFromSettings = settings.permissions.defaultMode
    }
    if (settings.permissions.additionalDirectories?.length) {
      for (const dir of settings.permissions.additionalDirectories) {
        const expanded = expandPath(dir)
        additionalWorkingDirectories.set(expanded, {
          path: expanded,
          source: ruleSource,
        })
      }
    }
  }

  if (options?.allowedCliRules?.length && !managedOnly) {
    alwaysAllowRules.cliArg = [...options.allowedCliRules]
  }
  if (options?.disallowedCliRules?.length) {
    alwaysDenyRules.cliArg = [...options.disallowedCliRules]
  }
  if (options?.additionalDirectories?.length) {
    for (const dir of options.additionalDirectories) {
      const expanded = expandPath(dir)
      additionalWorkingDirectories.set(expanded, {
        path: expanded,
        source: 'cliArg',
      })
    }
  }

  let effectiveMode: PermissionMode =
    options?.modeOverride ?? defaultModeFromSettings
  if (effectiveMode === 'bypassPermissions' && isBypassPermissionsDisabled()) {
    effectiveMode = 'default'
  }

  const bypassAvailable =
    Boolean(options?.isBypassPermissionsModeAvailable) &&
    !isBypassPermissionsDisabled()

  const context: ToolPermissionContext = {
    ...base,
    mode: effectiveMode,
    additionalWorkingDirectories,
    alwaysAllowRules,
    alwaysDenyRules,
    alwaysAskRules,
    isBypassPermissionsModeAvailable: bypassAvailable,
    ...(options?.shouldAvoidPermissionPrompts !== undefined
      ? { shouldAvoidPermissionPrompts: options.shouldAvoidPermissionPrompts }
      : {}),
  }

  if (effectiveMode === 'auto') {
    return stripDangerousAllowRulesForAutoMode(context)
  }

  return context
}
