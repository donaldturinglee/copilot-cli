/**
 * Marketplace-backed LSP plugin recommender (`getMatchingLspPlugins`) checking
 * binary availability via `which()` and user opt-outs (`lspRecommendationDisabled`,
 * `lspRecommendationNeverPlugins`, `lspRecommendationIgnoredCount`).
 */

import { extname } from 'path'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { which as findExecutable } from '../which.js'
import { getInstalledPluginsV2 } from './installed_plugins_manager.js'
import { listAllMarketplaces } from './marketplace_manager.js'
import { ALLOWED_OFFICIAL_MARKETPLACE_NAMES } from './official_marketplace.js'
import { formatPluginIdentifier } from './plugin_identifier.js'

const MAX_IGNORED_COUNT = 5
const binaryCheckCache = new Map<string, boolean>()

export interface LspPluginMatch {
  pluginId: string
  pluginName: string
  marketplace: string
  description?: string
}

/**
 * Returns true if LSP plugin recommendations are globally suppressed.
 */
export function isLspRecommendationsDisabled(): boolean {
  const cfg = getGlobalConfig()
  return (
    cfg.lspRecommendationDisabled === true ||
    (cfg.lspRecommendationIgnoredCount ?? 0) >= MAX_IGNORED_COUNT
  )
}

/**
 * Records a user dismissal timeout toward the 5-strike auto-disable cap.
 */
export function incrementLspIgnoredCount(): void {
  saveGlobalConfig(prev => ({
    ...prev,
    lspRecommendationIgnoredCount: (prev.lspRecommendationIgnoredCount ?? 0) + 1,
  }))
}

/**
 * Permanently suppresses LSP recommendations for `pluginId`.
 */
export function addToNeverSuggestLspPlugin(pluginId: string): void {
  saveGlobalConfig(prev => {
    const set = new Set(prev.lspRecommendationNeverPlugins ?? [])
    set.add(pluginId)
    return {
      ...prev,
      lspRecommendationNeverPlugins: Array.from(set),
    }
  })
}

/**
 * Finds uninstalled marketplace LSP plugins supporting `filePath`'s extension
 * whose server binary is already installed on `PATH`.
 */
export async function getMatchingLspPlugins(
  filePath: string,
): Promise<LspPluginMatch[]> {
  if (isLspRecommendationsDisabled()) {
    return []
  }
  const ext = extname(filePath).toLowerCase()
  if (!ext) {
    return []
  }

  const cfg = getGlobalConfig()
  const neverSet = new Set(cfg.lspRecommendationNeverPlugins ?? [])
  const installed = getInstalledPluginsV2().plugins
  const matches: LspPluginMatch[] = []

  const marketplaces = listAllMarketplaces().sort((a, b) => {
    const aOff = ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(a.name) ? 0 : 1
    const bOff = ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(b.name) ? 0 : 1
    return aOff - bOff
  })

  for (const mp of marketplaces) {
    for (const entry of mp.manifest?.plugins ?? []) {
      const pluginId = formatPluginIdentifier(entry.name, mp.name)
      if (neverSet.has(pluginId) || installed[pluginId]?.length) {
        continue
      }
      if (
        !entry.lspServers ||
        typeof entry.lspServers !== 'object' ||
        Array.isArray(entry.lspServers)
      ) {
        continue
      }
      for (const srvCfg of Object.values(entry.lspServers)) {
        const extMap = Object.keys(srvCfg.extensionToLanguage).map(k =>
          k.toLowerCase(),
        )
        if (!extMap.includes(ext)) continue
        let binExists = binaryCheckCache.get(srvCfg.command)
        if (binExists === undefined) {
          binExists = Boolean(await findExecutable(srvCfg.command))
          binaryCheckCache.set(srvCfg.command, binExists)
        }
        if (binExists) {
          matches.push({
            pluginId,
            pluginName: entry.name,
            marketplace: mp.name,
            description: entry.description,
          })
          break
        }
      }
    }
  }

  return matches
}
