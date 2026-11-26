import { logEvent } from '../services/analytics/index.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '../utilities/config.js'
import { logError } from '../utilities/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utilities/settings/settings.js'

/**
 * Migrates MCP server approval fields from project config into `localSettings`.
 */
export function migrateEnableAllProjectMcpServersToSettings(): void {
  const projectConfig = getCurrentProjectConfig()

  const hasEnableAll = projectConfig.enableAllProjectMcpServers !== undefined
  const hasEnabledServers =
    Boolean(projectConfig.enabledMcpjsonServers) &&
    projectConfig.enabledMcpjsonServers!.length > 0
  const hasDisabledServers =
    Boolean(projectConfig.disabledMcpjsonServers) &&
    projectConfig.disabledMcpjsonServers!.length > 0

  if (!hasEnableAll && !hasEnabledServers && !hasDisabledServers) {
    return
  }

  try {
    const existingSettings = getSettingsForSource('localSettings') || {}
    const updates: Partial<{
      enableAllProjectMcpServers: boolean
      enabledMcpjsonServers: string[]
      disabledMcpjsonServers: string[]
    }> = {}
    const fieldsToRemove: Array<
      | 'enableAllProjectMcpServers'
      | 'enabledMcpjsonServers'
      | 'disabledMcpjsonServers'
    > = []

    if (hasEnableAll) {
      if (existingSettings.enableAllProjectMcpServers === undefined) {
        updates.enableAllProjectMcpServers =
          projectConfig.enableAllProjectMcpServers
      }
      fieldsToRemove.push('enableAllProjectMcpServers')
    }

    if (hasEnabledServers && projectConfig.enabledMcpjsonServers) {
      const existingEnabledServers =
        existingSettings.enabledMcpjsonServers || []
      updates.enabledMcpjsonServers = [
        ...new Set([
          ...existingEnabledServers,
          ...projectConfig.enabledMcpjsonServers,
        ]),
      ]
      fieldsToRemove.push('enabledMcpjsonServers')
    }

    if (hasDisabledServers && projectConfig.disabledMcpjsonServers) {
      const existingDisabledServers =
        existingSettings.disabledMcpjsonServers || []
      updates.disabledMcpjsonServers = [
        ...new Set([
          ...existingDisabledServers,
          ...projectConfig.disabledMcpjsonServers,
        ]),
      ]
      fieldsToRemove.push('disabledMcpjsonServers')
    }

    if (Object.keys(updates).length > 0) {
      updateSettingsForSource('localSettings', updates)
    }

    if (fieldsToRemove.length > 0) {
      saveCurrentProjectConfig(current => {
        const updated = { ...current }
        delete updated.enableAllProjectMcpServers
        delete updated.enabledMcpjsonServers
        delete updated.disabledMcpjsonServers
        return updated
      })
    }

    logEvent('tengu_migrate_mcp_approval_fields_success', {
      migratedCount: fieldsToRemove.length,
    })
  } catch (error) {
    logError(error)
    logEvent('tengu_migrate_mcp_approval_fields_error', {})
  }
}
