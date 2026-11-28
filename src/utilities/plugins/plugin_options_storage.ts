/**
 * Split storage for plugin `userConfig` and MCPB `user_config`:
 * - `sensitive: true` values are stored exclusively in `SecureStorage`
 *   (`Keychain` on macOS / `0600` credential store) under `pluginSecrets`.
 * - Non-sensitive values are stored in `userSettings.pluginConfigs`.
 * - Prompt/Markdown substitution redacts `sensitive: true` keys so secrets never
 *   leak into model context.
 */

import { getSecureStorage } from '../secure_storage/index.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { UserConfigValues } from '../settings/types.js'
import { getPluginDataDir } from './plugin_directories.js'
import type { PluginUserConfigOption } from './schemas.js'

export type PluginOptionValues = Record<
  string,
  string | number | boolean | string[]
>

/**
 * Loads merged non-sensitive (`settings.pluginConfigs`) and sensitive
 * (`SecureStorage.pluginSecrets`) option values for `pluginId`.
 */
export function loadPluginOptions(pluginId: string): PluginOptionValues {
  const settings = getInitialSettings()
  const nonSensitive =
    (settings.pluginConfigs?.[pluginId]?.userConfig as
      | PluginOptionValues
      | undefined) ??
    (settings.pluginConfigs?.[pluginId]?.options as
      | PluginOptionValues
      | undefined) ??
    {}
  const secrets = getSecureStorage().read()?.pluginSecrets?.[pluginId] ?? {}
  return {
    ...nonSensitive,
    ...secrets,
  }
}

/**
 * Saves `values` for `pluginId`, routing `sensitive: true` fields to
 * `SecureStorage` FIRST and non-sensitive fields to `userSettings.pluginConfigs`.
 */
export function savePluginOptions(
  pluginId: string,
  values: PluginOptionValues,
  schema: Record<string, { sensitive?: boolean }> = {},
): void {
  const sensitiveEntries: Record<string, string> = {}
  const publicEntries: Record<string, string | number | boolean | undefined> = {}

  for (const [key, val] of Object.entries(values)) {
    if (schema[key]?.sensitive) {
      sensitiveEntries[key] = Array.isArray(val) ? val.join(',') : String(val)
      // Explicitly clear any stale plaintext value in settings.json
      publicEntries[key] = undefined
    } else {
      publicEntries[key] = Array.isArray(val) ? val.join(',') : val
    }
  }

  const storage = getSecureStorage()
  const currentSecrets = storage.read() ?? {}
  const nextPluginSecrets = { ...(currentSecrets.pluginSecrets ?? {}) }
  if (Object.keys(sensitiveEntries).length > 0) {
    nextPluginSecrets[pluginId] = {
      ...(nextPluginSecrets[pluginId] ?? {}),
      ...sensitiveEntries,
    }
  } else {
    delete nextPluginSecrets[pluginId]
  }
  const res = storage.update({
    ...currentSecrets,
    pluginSecrets: nextPluginSecrets,
  })
  if (!res.success) {
    throw new Error(
      `Failed to save sensitive plugin options to secure storage: ${res.warning ?? 'unknown error'}`,
    )
  }

  const prevConfigs = getInitialSettings().pluginConfigs ?? {}
  const prevPluginCfg = prevConfigs[pluginId] ?? {}
  updateSettingsForSource('userSettings', {
    pluginConfigs: {
      ...prevConfigs,
      [pluginId]: {
        ...prevPluginCfg,
        userConfig: {
          ...(prevPluginCfg.userConfig ?? {}),
          ...(publicEntries as UserConfigValues),
        },
      },
    },
  })
}

/**
 * Loads merged user configuration for a specific MCPB server inside `pluginId`.
 */
export function loadMcpServerUserConfig(
  pluginId: string,
  serverName: string,
): PluginOptionValues {
  const settings = getInitialSettings()
  const pluginConfigsMap = settings.pluginConfigs as
    | Record<string, { mcpServers?: Record<string, PluginOptionValues> }>
    | undefined
  const nonSensitive =
    pluginConfigsMap?.[pluginId]?.mcpServers?.[serverName] ?? {}
  const secretKey = `${pluginId}/${serverName}`
  const secrets = getSecureStorage().read()?.pluginSecrets?.[secretKey] ?? {}
  return {
    ...nonSensitive,
    ...secrets,
  }
}

/**
 * Saves user configuration for an MCPB server inside `pluginId`, storing
 * `sensitive: true` fields in `SecureStorage`.
 */
export function saveMcpServerUserConfig(
  pluginId: string,
  serverName: string,
  values: PluginOptionValues,
  schema: Record<string, { sensitive?: boolean }> = {},
): void {
  const secretKey = `${pluginId}/${serverName}`
  const sensitiveEntries: Record<string, string> = {}
  const publicEntries: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(values)) {
    if (schema[key]?.sensitive) {
      sensitiveEntries[key] = Array.isArray(val) ? val.join(',') : String(val)
      publicEntries[key] = undefined
    } else {
      publicEntries[key] = val
    }
  }

  const storage = getSecureStorage()
  const currentSecrets = storage.read() ?? {}
  const nextPluginSecrets = { ...(currentSecrets.pluginSecrets ?? {}) }
  if (Object.keys(sensitiveEntries).length > 0) {
    nextPluginSecrets[secretKey] = sensitiveEntries
  } else {
    delete nextPluginSecrets[secretKey]
  }
  const res = storage.update({
    ...currentSecrets,
    pluginSecrets: nextPluginSecrets,
  })
  if (!res.success) {
    throw new Error('Failed to store MCPB sensitive configuration')
  }

  const prevConfigs = getInitialSettings().pluginConfigs ?? {}
  const prevPluginCfg = prevConfigs[pluginId] ?? {}
  updateSettingsForSource('userSettings', {
    pluginConfigs: {
      ...prevConfigs,
      [pluginId]: {
        ...prevPluginCfg,
        mcpServers: {
          ...(prevPluginCfg.mcpServers ?? {}),
          [serverName]: publicEntries,
        },
      },
    },
  })
}

/**
 * Deletes all stored `userConfig` and `pluginSecrets` for `pluginId` upon final
 * uninstall.
 */
export function deletePluginOptions(pluginId: string): void {
  const storage = getSecureStorage()
  const current = storage.read()
  if (current?.pluginSecrets) {
    const nextSecrets: Record<string, Record<string, string>> = {}
    for (const [k, v] of Object.entries(current.pluginSecrets)) {
      if (k !== pluginId && !k.startsWith(`${pluginId}/`)) {
        nextSecrets[k] = v
      }
    }
    storage.update({ ...current, pluginSecrets: nextSecrets })
  }

  const prevConfigs = getInitialSettings().pluginConfigs
  if (prevConfigs && pluginId in prevConfigs) {
    updateSettingsForSource('userSettings', {
      pluginConfigs: {
        ...prevConfigs,
        [pluginId]: undefined as unknown as never,
      },
    })
  }
}

/**
 * Substitutes `${COPILOT_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` and
 * `${COPILOT_PLUGIN_DATA}` / `${CLAUDE_PLUGIN_DATA}` (lazily creating the data
 * directory when referenced).
 */
export function substitutePluginRootAndData(
  text: string,
  pluginRoot: string,
  pluginId: string,
  posixSlashes = false,
): string {
  const fmt = (p: string) => (posixSlashes ? p.replace(/\\/g, '/') : p)
  let result = text.replace(
    /\$\{(?:COPILOT|CLAUDE)_PLUGIN_ROOT\}/g,
    () => fmt(pluginRoot),
  )
  if (/\$\{(?:COPILOT|CLAUDE)_PLUGIN_DATA\}/.test(result)) {
    const dataDir = getPluginDataDir(pluginId, true)
    result = result.replace(
      /\$\{(?:COPILOT|CLAUDE)_PLUGIN_DATA\}/g,
      () => fmt(dataDir),
    )
  }
  return result
}

/**
 * Substitutes `${user_config.KEY}` in process/MCP/LSP/Hook execution configs
 * where raw secret values are permitted.
 */
export function substituteUserConfigVariables(
  text: string,
  options: PluginOptionValues,
  schema?: Record<string, PluginUserConfigOption>,
): string {
  return text.replace(
    /\$\{user_config\.([A-Za-z_]\w*)\}/g,
    (fullMatch: string, key: string) => {
      const val = options[key] ?? schema?.[key]?.default
      if (val === undefined) {
        return fullMatch
      }
      return Array.isArray(val) ? val.join(',') : String(val)
    },
  )
}

/**
 * Substitutes `${user_config.KEY}` in Markdown prompts/skills/agents while
 * redacting `sensitive: true` keys so secrets never enter LLM context.
 */
export function substituteUserConfigInContent(
  content: string,
  options: PluginOptionValues,
  schema?: Record<string, PluginUserConfigOption>,
): string {
  return content.replace(
    /\$\{user_config\.([A-Za-z_]\w*)\}/g,
    (fullMatch: string, key: string) => {
      if (schema?.[key]?.sensitive) {
        return `[sensitive option '${key}' not available in skill content]`
      }
      const val = options[key] ?? schema?.[key]?.default
      if (val === undefined) {
        return fullMatch
      }
      return Array.isArray(val) ? val.join(', ') : String(val)
    },
  )
}
