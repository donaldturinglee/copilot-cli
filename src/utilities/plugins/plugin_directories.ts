/**
 * Physical directory layout for `~/.copilot/plugins` (`installed_plugins.json`,
 * `known_marketplaces.json`, `marketplaces/`, `cache/`, `data/`, `flagged-plugins.json`)
 * and dual `.copilot-plugin` / `.claude-plugin` manifest path resolution.
 */

import { existsSync, mkdirSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { getUseCoworkPlugins } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../env_utils.js'
import { sanitizePluginId } from './plugin_identifier.js'

/**
 * Returns the base plugins directory (`~/.copilot/plugins`, or env override
 * `COPILOT_CLI_PLUGIN_CACHE_DIR` / `CLAUDE_CODE_PLUGIN_CACHE_DIR`).
 */
export function getPluginsDirectory(): string {
  const envOverride =
    process.env.COPILOT_CLI_PLUGIN_CACHE_DIR ??
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  if (envOverride && envOverride.trim()) {
    return resolve(envOverride.trim())
  }
  const subdir = getUseCoworkPlugins() ? 'cowork_plugins' : 'plugins'
  return join(getClaudeConfigHomeDir(), subdir)
}

export function getInstalledPluginsFilePath(): string {
  return join(getPluginsDirectory(), 'installed_plugins.json')
}

export function getKnownMarketplacesFilePath(): string {
  return join(getPluginsDirectory(), 'known_marketplaces.json')
}

export function getFlaggedPluginsFilePath(): string {
  return join(getPluginsDirectory(), 'flagged-plugins.json')
}

export function getMarketplacesDir(): string {
  return join(getPluginsDirectory(), 'marketplaces')
}

export function getPluginCacheRoot(): string {
  return join(getPluginsDirectory(), 'cache')
}

/**
 * Returns the immutable versioned cache directory for a marketplace plugin.
 */
export function getVersionedPluginCachePath(
  marketplace: string,
  pluginName: string,
  version = 'latest',
): string {
  const safeMp = marketplace.replace(/[^a-zA-Z0-9._-]/g, '_')
  const safeName = pluginName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const safeVer = version.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(getPluginCacheRoot(), safeMp, safeName, safeVer)
}

/**
 * Returns the persistent `${COPILOT_PLUGIN_DATA}` / `${CLAUDE_PLUGIN_DATA}`
 * directory for `pluginId`, creating it lazily when `ensureCreated` is true.
 */
export function getPluginDataDir(
  pluginId: string,
  ensureCreated = false,
): string {
  const dir = join(getPluginsDirectory(), 'data', sanitizePluginId(pluginId))
  if (ensureCreated) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

/**
 * Resolves `plugin.json` inside `pluginDir`, checking `.copilot-plugin/plugin.json`,
 * `.claude-plugin/plugin.json`, and root `plugin.json`.
 */
export function findPluginManifestPath(pluginDir: string): string | null {
  const candidates = [
    join(pluginDir, '.copilot-plugin', 'plugin.json'),
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    join(pluginDir, 'plugin.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Resolves `marketplace.json` inside `dir`, checking `.copilot-plugin/marketplace.json`,
 * `.claude-plugin/marketplace.json`, and root `marketplace.json`.
 */
export function findMarketplaceManifestPath(dir: string): string | null {
  const candidates = [
    join(dir, '.copilot-plugin', 'marketplace.json'),
    join(dir, '.claude-plugin', 'marketplace.json'),
    join(dir, 'marketplace.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Verifies that `subPath` resolves inside `pluginRoot` without `..` or absolute
 * escape.
 */
export function resolvePathWithinPlugin(
  pluginRoot: string,
  subPath: string,
): string | null {
  if (!subPath || isAbsolute(subPath)) {
    return null
  }
  const resolvedRoot = resolve(pluginRoot)
  const resolvedTarget = resolve(resolvedRoot, subPath)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    (resolvedTarget !== resolvedRoot &&
      !resolvedTarget.startsWith(`${resolvedRoot}${sep}`))
  ) {
    return null
  }
  return resolvedTarget
}
