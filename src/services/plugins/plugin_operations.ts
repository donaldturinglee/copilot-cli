/**
 * High-level plugin lifecycle operations (`installPluginOp`, `uninstallPluginOp`,
 * `enablePluginOp`, `disablePluginOp`, `updatePluginOp`) shared across CLI
 * subcommands and the `/plugin` interactive TUI.
 */

import { rmSync } from 'fs'
import { getCwd } from '../../utilities/cwd.js'
import {
  findReverseDependents,
  resolveDependencyClosure,
} from '../../utilities/plugins/dependency_resolver.js'
import {
  getInstalledPluginsV2,
  recordInstalledPlugin,
  removeInstalledPluginEntry,
  resolveInstalledPluginEntry,
} from '../../utilities/plugins/installed_plugins_manager.js'
import {
  cacheMarketplacePlugin,
  listAllMarketplaces,
  loadMarketplaceManifest,
} from '../../utilities/plugins/marketplace_manager.js'
import { getPluginDataDir } from '../../utilities/plugins/plugin_directories.js'
import {
  formatPluginIdentifier,
  parsePluginIdentifier,
} from '../../utilities/plugins/plugin_identifier.js'
import { loadAllPluginsCacheOnly } from '../../utilities/plugins/plugin_loader.js'
import { deletePluginOptions } from '../../utilities/plugins/plugin_options_storage.js'
import {
  isPluginBlockedByPolicy,
  isPluginManaged,
} from '../../utilities/plugins/plugin_policy.js'
import { clearAllPluginCaches } from '../../utilities/plugins/refresh.js'
import type { PersistablePluginScope } from '../../utilities/plugins/schemas.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utilities/settings/settings.js'
import type { SettingSource } from '../../types/forward.js'

export type MutablePluginScope = 'user' | 'project' | 'local'

function toSettingSource(scope: MutablePluginScope): SettingSource {
  switch (scope) {
    case 'project':
      return 'projectSettings'
    case 'local':
      return 'localSettings'
    case 'user':
    default:
      return 'userSettings'
  }
}

/**
 * Resolves a bare `plugin` or `plugin@marketplace` specifier against registered
 * marketplaces.
 */
export function resolveTargetPluginId(rawSpec: string): {
  pluginId: string
  name: string
  marketplace: string
} {
  const parsed = parsePluginIdentifier(rawSpec)
  if (parsed.marketplace) {
    return {
      pluginId: formatPluginIdentifier(parsed.name, parsed.marketplace),
      name: parsed.name,
      marketplace: parsed.marketplace,
    }
  }

  for (const mp of listAllMarketplaces()) {
    if (mp.manifest?.plugins.some(p => p.name === parsed.name)) {
      return {
        pluginId: formatPluginIdentifier(parsed.name, mp.name),
        name: parsed.name,
        marketplace: mp.name,
      }
    }
  }

  // Fallback to installed registry lookup by bare name
  const installed = getInstalledPluginsV2(true).plugins
  for (const existingId of Object.keys(installed)) {
    const p = parsePluginIdentifier(existingId)
    if (p.name === parsed.name && p.marketplace) {
      return {
        pluginId: existingId,
        name: p.name,
        marketplace: p.marketplace,
      }
    }
  }

  throw new Error(
    `Plugin "${rawSpec}" was not found in any configured marketplace.`,
  )
}

/**
 * Installs `rawSpec` and its transitive dependency closure into `scope`,
 * caching each plugin snapshot and enabling them in settings.
 */
export async function installPluginOp(
  rawSpec: string,
  scope: MutablePluginScope = 'user',
): Promise<{
  pluginId: string
  installedClosure: string[]
  version: string
}> {
  const { pluginId } = resolveTargetPluginId(rawSpec)
  if (isPluginBlockedByPolicy(pluginId)) {
    throw new Error(`Plugin "${pluginId}" is blocked by enterprise policy.`)
  }

  const currentSettings = getInitialSettings()
  const currentInstalled = getInstalledPluginsV2(true).plugins

  const depResult = resolveDependencyClosure(
    pluginId,
    candidateId => {
      const p = parsePluginIdentifier(candidateId)
      if (!p.marketplace) return null
      const mp = loadMarketplaceManifest(p.marketplace)
      const entry = mp?.plugins.find(item => item.name === p.name)
      if (!entry) return null
      return {
        dependencies: entry.dependencies?.map(d => String(d)),
        allowCrossMarketplaceDependenciesOn:
          mp?.allowCrossMarketplaceDependenciesOn,
      }
    },
    candidateId =>
      Boolean(
        currentInstalled[candidateId]?.length &&
          currentSettings.enabledPlugins?.[candidateId],
      ),
  )

  if (depResult.errors.length > 0) {
    throw new Error(depResult.errors.map(e => e.message).join('; '))
  }

  const settingSource = toSettingSource(scope)
  const projectPath = scope === 'project' || scope === 'local' ? getCwd() : undefined
  const enabledAdditions: Record<string, boolean> = {}
  let rootVersion = '0.0.0'

  for (const id of depResult.closure) {
    const p = parsePluginIdentifier(id)
    if (!p.marketplace) continue
    const mp = loadMarketplaceManifest(p.marketplace)
    const entry = mp?.plugins.find(item => item.name === p.name)
    if (!entry) {
      throw new Error(`Plugin "${id}" not found in marketplace "${p.marketplace}"`)
    }
    const cached = await cacheMarketplacePlugin(p.marketplace, entry)
    if (id === pluginId) {
      rootVersion = cached.version
    }
    recordInstalledPlugin(id, {
      scope,
      ...(projectPath ? { projectPath } : {}),
      installPath: cached.installPath,
      version: cached.version,
      installedAt: new Date().toISOString(),
    })
    enabledAdditions[id] = true
  }

  const prevScopeEnabled =
    getSettingsForSource(settingSource)?.enabledPlugins ?? {}
  updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...prevScopeEnabled,
      ...enabledAdditions,
    },
  })

  clearAllPluginCaches()
  return {
    pluginId,
    installedClosure: depResult.closure,
    version: rootVersion,
  }
}

/**
 * Uninstalls `rawSpec` from `scope`, deleting options and `${COPILOT_PLUGIN_DATA}`
 * when no other scope installations remain (unless `keepData` is true).
 */
export async function uninstallPluginOp(
  rawSpec: string,
  options?: {
    scope?: MutablePluginScope
    keepData?: boolean
  },
): Promise<{
  pluginId: string
  warnings: string[]
}> {
  const { pluginId } = resolveTargetPluginId(rawSpec)
  if (isPluginManaged(pluginId)) {
    throw new Error(
      `Plugin "${pluginId}" is managed by enterprise policy and cannot be uninstalled.`,
    )
  }

  const scope = options?.scope ?? 'user'
  const loaded = await loadAllPluginsCacheOnly()
  const dependents = findReverseDependents(pluginId, loaded.enabled)
  const warnings =
    dependents.length > 0
      ? [
          `Warning: Enabled plugin(s) depend on "${pluginId}": ${dependents.join(', ')}`,
        ]
      : []

  const projectPath =
    scope === 'project' || scope === 'local' ? getCwd() : undefined
  const removal = removeInstalledPluginEntry(pluginId, scope, projectPath)
  if (!removal.removed) {
    throw new Error(`Plugin "${pluginId}" is not installed in ${scope} scope.`)
  }

  const settingSource = toSettingSource(scope)
  const prevEnabled = getSettingsForSource(settingSource)?.enabledPlugins ?? {}
  if (pluginId in prevEnabled) {
    updateSettingsForSource(settingSource, {
      enabledPlugins: {
        ...prevEnabled,
        [pluginId]: undefined as unknown as boolean,
      },
    })
  }

  if (removal.remainingEntries.length === 0) {
    deletePluginOptions(pluginId)
    if (!options?.keepData) {
      rmSync(getPluginDataDir(pluginId), { recursive: true, force: true })
    }
  }

  clearAllPluginCaches()
  return { pluginId, warnings }
}

/**
 * Enables an installed plugin in `scope`.
 */
export async function enablePluginOp(
  rawSpec: string,
  scope?: MutablePluginScope,
): Promise<{ pluginId: string; scope: MutablePluginScope }> {
  const { pluginId } = resolveTargetPluginId(rawSpec)
  if (isPluginBlockedByPolicy(pluginId)) {
    throw new Error(`Plugin "${pluginId}" is blocked by enterprise policy.`)
  }
  const detectedEntry = resolveInstalledPluginEntry(pluginId)
  const targetScope: MutablePluginScope =
    scope ??
    (detectedEntry?.scope === 'project' || detectedEntry?.scope === 'local'
      ? detectedEntry.scope
      : 'user')
  const settingSource = toSettingSource(targetScope)
  const prev = getSettingsForSource(settingSource)?.enabledPlugins ?? {}
  updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...prev,
      [pluginId]: true,
    },
  })
  clearAllPluginCaches()
  return { pluginId, scope: targetScope }
}

/**
 * Disables one plugin (or all enabled plugins when `disableAll` is true) in `scope`.
 */
export async function disablePluginOp(params: {
  rawSpec?: string
  scope?: MutablePluginScope
  disableAll?: boolean
}): Promise<{ disabledIds: string[]; warnings: string[] }> {
  const targetScope = params.scope ?? 'user'
  const settingSource = toSettingSource(targetScope)
  const loaded = await loadAllPluginsCacheOnly()

  if (params.disableAll) {
    const ids = loaded.enabled
      .map(p => p.source)
      .filter(id => !id.endsWith('@inline') && !isPluginManaged(id))
    const updates: Record<string, boolean> = {}
    for (const id of ids) {
      updates[id] = false
    }
    const prev = getSettingsForSource(settingSource)?.enabledPlugins ?? {}
    updateSettingsForSource(settingSource, {
      enabledPlugins: { ...prev, ...updates },
    })
    clearAllPluginCaches()
    return { disabledIds: ids, warnings: [] }
  }

  if (!params.rawSpec) {
    throw new Error('Specify a plugin name or pass --all.')
  }

  const { pluginId } = resolveTargetPluginId(params.rawSpec)
  if (isPluginManaged(pluginId)) {
    throw new Error(
      `Plugin "${pluginId}" is managed by enterprise policy and cannot be modified.`,
    )
  }

  const dependents = findReverseDependents(pluginId, loaded.enabled)
  const warnings =
    dependents.length > 0
      ? [
          `Warning: Enabled plugin(s) depend on "${pluginId}": ${dependents.join(', ')}`,
        ]
      : []

  const prev = getSettingsForSource(settingSource)?.enabledPlugins ?? {}
  updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...prev,
      [pluginId]: false,
    },
  })
  clearAllPluginCaches()
  return { disabledIds: [pluginId], warnings }
}

/**
 * Re-fetches and updates `rawSpec` from its marketplace into `scope`.
 */
export async function updatePluginOp(
  rawSpec: string,
  scope: MutablePluginScope = 'user',
): Promise<{ pluginId: string; version: string }> {
  const { pluginId, name, marketplace } = resolveTargetPluginId(rawSpec)
  const mp = loadMarketplaceManifest(marketplace)
  const entry = mp?.plugins.find(p => p.name === name)
  if (!entry) {
    throw new Error(`Plugin "${pluginId}" not found in marketplace "${marketplace}".`)
  }
  const cached = await cacheMarketplacePlugin(marketplace, entry)
  const projectPath =
    scope === 'project' || scope === 'local' ? getCwd() : undefined
  recordInstalledPlugin(pluginId, {
    scope,
    ...(projectPath ? { projectPath } : {}),
    installPath: cached.installPath,
    version: cached.version,
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  })
  clearAllPluginCaches()
  return { pluginId, version: cached.version }
}
