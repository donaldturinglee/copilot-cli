import type {
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../../types/permissions.js'
import { permissionRuleValueToString } from '../../utilities/permissions/permission_rule_parser.js'
import type { EditableSettingSource } from '../../utilities/settings/constants.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utilities/settings/settings.js'

export function buildAlwaysAllowRuleForTool(
  toolName: string,
  input: Record<string, unknown>,
): PermissionRuleValue {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : ''
    const firstToken = cmd.split(/\s+/)[0]
    if (firstToken) {
      return { toolName, ruleContent: `${firstToken}:*` }
    }
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    try {
      const host = new URL(input.url).hostname
      if (host) return { toolName, ruleContent: `domain:${host}` }
    } catch {
      // fall through to blanket rule
    }
  }
  return { toolName }
}

export function buildAlwaysAllowUpdate(
  toolName: string,
  input: Record<string, unknown>,
  destination: PermissionUpdateDestination = 'localSettings',
  existingSuggestions?: PermissionUpdate[],
): PermissionUpdate[] {
  const ruleSuggestions = existingSuggestions?.filter(
    s => s.type === 'addRules' && s.behavior === 'allow',
  )
  if (ruleSuggestions && ruleSuggestions.length > 0) {
    return ruleSuggestions.map(s => ({
      ...s,
      destination,
    }))
  }
  return [
    {
      type: 'addRules',
      rules: [buildAlwaysAllowRuleForTool(toolName, input)],
      behavior: 'allow',
      destination,
    },
  ]
}

function isEditableSource(
  dest: PermissionUpdateDestination,
): dest is EditableSettingSource {
  return (
    dest === 'userSettings' ||
    dest === 'projectSettings' ||
    dest === 'localSettings'
  )
}

/**
 * Persists `addRules` / `removeRules` / `setMode` permission updates to the
 * appropriate `settings.json` / `settings.local.json` file on disk so
 * "Always allow" rules survive across CLI restarts.
 */
export function persistPermissionUpdates(
  updates: readonly PermissionUpdate[],
): { persistedCount: number; errors: string[] } {
  let persistedCount = 0
  const errors: string[] = []

  for (const update of updates) {
    if (!isEditableSource(update.destination)) continue

    const current = getSettingsForSource(update.destination) ?? {}
    const currentPerms = current.permissions ?? {}

    if (update.type === 'addRules') {
      const key = update.behavior
      const existingList = [...(currentPerms[key] ?? [])]
      const addedStrings = update.rules.map(permissionRuleValueToString)
      const merged = Array.from(new Set([...existingList, ...addedStrings]))
      const res = updateSettingsForSource(update.destination, {
        permissions: {
          ...currentPerms,
          [key]: merged,
        },
      })
      if (res.error) errors.push(res.error.message)
      else persistedCount += addedStrings.length
    } else if (update.type === 'removeRules') {
      const key = update.behavior
      const toRemove = new Set(update.rules.map(permissionRuleValueToString))
      const filtered = (currentPerms[key] ?? []).filter(r => !toRemove.has(r))
      const res = updateSettingsForSource(update.destination, {
        permissions: {
          ...currentPerms,
          [key]: filtered,
        },
      })
      if (res.error) errors.push(res.error.message)
      else persistedCount += toRemove.size
    } else if (update.type === 'setMode') {
      const res = updateSettingsForSource(update.destination, {
        permissions: {
          ...currentPerms,
          defaultMode: update.mode,
        },
      })
      if (res.error) errors.push(res.error.message)
      else persistedCount += 1
    } else if (update.type === 'addDirectories') {
      const existingDirs = [...(currentPerms.additionalDirectories ?? [])]
      const merged = Array.from(new Set([...existingDirs, ...update.directories]))
      const res = updateSettingsForSource(update.destination, {
        permissions: {
          ...currentPerms,
          additionalDirectories: merged,
        },
      })
      if (res.error) errors.push(res.error.message)
      else persistedCount += update.directories.length
    }
  }

  return { persistedCount, errors }
}
