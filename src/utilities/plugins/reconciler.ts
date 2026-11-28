/**
 * Background three-layer reconciler materializing `settings.extraKnownMarketplaces`
 * and missing `settings.enabledPlugins` into `~/.copilot/plugins`, plus
 * `forceRemoveDeletedPlugins` delisted-plugin enforcement.
 */

import { getInitialSettings, updateSettingsForSource } from '../settings/settings.js'
import {
  getInstalledPluginsV2,
  recordInstalledPlugin,
  removeInstalledPluginEntry,
} from './installed_plugins_manager.js'
import {
  addMarketplace,
  cacheMarketplacePlugin,
  loadMarketplaceManifest,
  readKnownMarketplaces,
} from './marketplace_manager.js'
import { OFFICIAL_MARKETPLACE_NAME } from './official_marketplace.js'
import { recordFlaggedPlugin } from './plugin_blocklist.js'
import { parsePluginIdentifier } from './plugin_identifier.js'
import type { MarketplaceSource } from './schemas.js'

export interface ReconcileResult {
  addedMarketplaces: string[]
  cachedPlugins: string[]
  removedDelistedPlugins: string[]
  changed: boolean
}

/**
 * Reconciles `extraKnownMarketplaces` and `enabledPlugins` from settings with
 * physical installations on disk, and removes any plugins delisted from
 * marketplaces enforcing `forceRemoveDeletedPlugins`.
 */
export async function reconcileMarketplacesAndPlugins(options?: {
  updateMemorySnapshot?: boolean
}): Promise<ReconcileResult> {
  const settings = getInitialSettings()
  const knownMarketplaces = readKnownMarketplaces()
  const addedMarketplaces: string[] = []
  const cachedPlugins: string[] = []
  const removedDelistedPlugins: string[] = []

  // 1. Materialize missing `extraKnownMarketplaces`
  for (const [mpName, extraCfg] of Object.entries(
    settings.extraKnownMarketplaces ?? {},
  )) {
    if (knownMarketplaces[mpName]) continue
    const rawSource = extraCfg.source as unknown as MarketplaceSource
    if (!rawSource || typeof rawSource !== 'object') continue
    try {
      const added = await addMarketplace(rawSource, {
        autoUpdate: extraCfg.autoUpdate,
      })
      addedMarketplaces.push(added.name)
    } catch {
      // Ignore unreachable extra marketplaces during background reconcile
    }
  }

  // 2. Enforce delisted plugin removal on marketplaces with `forceRemoveDeletedPlugins`
  const installed = getInstalledPluginsV2(true)
  for (const [pluginId, entries] of Object.entries(installed.plugins)) {
    if (entries.length === 0) continue
    const parsed = parsePluginIdentifier(pluginId)
    if (!parsed.marketplace) continue
    const mpManifest = loadMarketplaceManifest(parsed.marketplace)
    if (!mpManifest) continue
    const enforceRemoval =
      mpManifest.forceRemoveDeletedPlugins === true ||
      parsed.marketplace === OFFICIAL_MARKETPLACE_NAME
    if (!enforceRemoval) continue

    const stillExists = mpManifest.plugins.some(p => p.name === parsed.name)
    if (!stillExists) {
      for (const entry of entries) {
        removeInstalledPluginEntry(pluginId, entry.scope, entry.projectPath)
      }
      const prevEnabled = settings.enabledPlugins ?? {}
      if (prevEnabled[pluginId]) {
        updateSettingsForSource('userSettings', {
          enabledPlugins: { ...prevEnabled, [pluginId]: false },
        })
      }
      recordFlaggedPlugin({
        id: pluginId,
        name: parsed.name,
        marketplace: parsed.marketplace,
        reason: 'Removed from marketplace',
        flaggedAt: new Date().toISOString(),
      })
      removedDelistedPlugins.push(pluginId)
    }
  }

  // 3. Cache any `enabledPlugins` missing from `installed_plugins.json`
  const refreshedInstalled = getInstalledPluginsV2(true)
  for (const [pluginId, enabledVal] of Object.entries(
    settings.enabledPlugins ?? {},
  )) {
    if (!enabledVal) continue
    if (refreshedInstalled.plugins[pluginId]?.length) continue
    const parsed = parsePluginIdentifier(pluginId)
    if (!parsed.marketplace) continue
    const mpManifest = loadMarketplaceManifest(parsed.marketplace)
    const mpEntry = mpManifest?.plugins.find(p => p.name === parsed.name)
    if (!mpEntry) continue
    try {
      const cached = await cacheMarketplacePlugin(parsed.marketplace, mpEntry)
      recordInstalledPlugin(
        pluginId,
        {
          scope: 'user',
          installPath: cached.installPath,
          version: cached.version,
          installedAt: new Date().toISOString(),
        },
        { updateMemorySnapshot: options?.updateMemorySnapshot ?? false },
      )
      cachedPlugins.push(pluginId)
    } catch {
      // Ignore individual cache errors during background reconcile
    }
  }

  return {
    addedMarketplaces,
    cachedPlugins,
    removedDelistedPlugins,
    changed:
      addedMarketplaces.length > 0 ||
      cachedPlugins.length > 0 ||
      removedDelistedPlugins.length > 0,
  }
}
