/**
 * Core plugin loader (`loadAllPlugins` and fast-path `loadAllPluginsCacheOnly`)
 * merging session `--plugin-dir` (`@inline`), marketplace (`installed_plugins.json`
 * + `settings.enabledPlugins`), and `@builtin` plugins, wiring `plugin.settings`
 * into `setPluginSettingsBase()`, and running `verifyAndDemote()`.
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { getInlinePlugins } from '../../bootstrap/state.js'
import { getBuiltinPlugins } from '../../plugins/builtin_plugins.js'
import type {
  LoadedPlugin,
  PluginError,
  PluginLoadResult,
  PluginManifest,
} from '../../types/plugin.js'
import { getCwd } from '../cwd.js'
import { isBareMode } from '../env_utils.js'
import { getInitialSettings } from '../settings/settings.js'
import { setPluginSettingsBase } from '../settings/settings_cache.js'
import { verifyAndDemote } from './dependency_resolver.js'
import {
  getInstalledPluginsV2,
  recordInstalledPlugin,
  resolveInstalledPluginEntry,
} from './installed_plugins_manager.js'
import {
  cacheMarketplacePlugin,
  loadMarketplaceManifest,
} from './marketplace_manager.js'
import {
  findPluginManifestPath,
  resolvePathWithinPlugin,
} from './plugin_directories.js'
import { parsePluginIdentifier } from './plugin_identifier.js'
import {
  getManagedPluginNames,
  isPluginBlockedByPolicy,
} from './plugin_policy.js'
import { PluginHooksSchema, PluginManifestSchema } from './schemas.js'

let cachedLoadResult: PluginLoadResult | null = null

/**
 * Clears the memoized plugin load result.
 */
export function clearPluginCache(): void {
  cachedLoadResult = null
}

function toPathArray(
  pluginRoot: string,
  spec: string | string[] | undefined,
  conventionalSubdir?: string,
): string[] {
  const paths: string[] = []
  if (conventionalSubdir) {
    const conv = join(pluginRoot, conventionalSubdir)
    if (existsSync(conv)) {
      paths.push(conv)
    }
  }
  if (!spec) {
    return paths
  }
  const rawList = Array.isArray(spec) ? spec : [spec]
  for (const rel of rawList) {
    const resolved = resolvePathWithinPlugin(pluginRoot, rel)
    if (resolved && existsSync(resolved) && !paths.includes(resolved)) {
      paths.push(resolved)
    }
  }
  return paths
}

function loadHooksConfigFromPlugin(
  pluginRoot: string,
  manifest: PluginManifest,
  pluginName: string,
  errors: PluginError[],
): Record<string, unknown[]> | undefined {
  const mergedHooks: Record<string, unknown[]> = {}

  const mergeMap = (map: Record<string, unknown[]>) => {
    for (const [ev, matchers] of Object.entries(map)) {
      mergedHooks[ev] = [...(mergedHooks[ev] ?? []), ...matchers]
    }
  }

  const conventionalPath = join(pluginRoot, 'hooks', 'hooks.json')
  if (existsSync(conventionalPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(conventionalPath, 'utf8'))
      const parsed = PluginHooksSchema().safeParse(raw)
      if (parsed.success) {
        mergeMap(parsed.data.hooks)
      } else {
        errors.push({
          type: 'hook-load-failed',
          source: pluginName,
          plugin: pluginName,
          hookPath: conventionalPath,
          reason: parsed.error.message,
        })
      }
    } catch (error) {
      errors.push({
        type: 'hook-load-failed',
        source: pluginName,
        plugin: pluginName,
        hookPath: conventionalPath,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (manifest.hooks) {
    const specs = Array.isArray(manifest.hooks)
      ? manifest.hooks
      : [manifest.hooks]
    for (const spec of specs) {
      if (typeof spec === 'string') {
        const hookFile = resolvePathWithinPlugin(pluginRoot, spec)
        if (!hookFile || !existsSync(hookFile)) {
          errors.push({
            type: 'hook-load-failed',
            source: pluginName,
            plugin: pluginName,
            hookPath: spec,
            reason: 'Hook JSON file not found or outside plugin root',
          })
          continue
        }
        try {
          const raw: unknown = JSON.parse(readFileSync(hookFile, 'utf8'))
          const parsed = PluginHooksSchema().safeParse(raw)
          if (parsed.success) {
            mergeMap(parsed.data.hooks)
          } else {
            errors.push({
              type: 'hook-load-failed',
              source: pluginName,
              plugin: pluginName,
              hookPath: hookFile,
              reason: parsed.error.message,
            })
          }
        } catch (error) {
          errors.push({
            type: 'hook-load-failed',
            source: pluginName,
            plugin: pluginName,
            hookPath: hookFile,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      } else if (spec && typeof spec === 'object') {
        mergeMap(spec)
      }
    }
  }

  return Object.keys(mergedHooks).length > 0 ? mergedHooks : undefined
}

/**
 * Instantiates a `LoadedPlugin` from a physical directory on disk.
 */
export function createPluginFromPath(params: {
  pluginPath: string
  sourceId: string
  repository: string
  enabled: boolean
  errors: PluginError[]
  fallbackManifest?: Partial<PluginManifest>
}): LoadedPlugin | null {
  const root = resolve(params.pluginPath)
  const manifestPath = findPluginManifestPath(root)
  let manifest: PluginManifest

  if (manifestPath) {
    let rawJson: unknown
    try {
      rawJson = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      params.errors.push({
        type: 'manifest-parse-error',
        source: params.sourceId,
        manifestPath,
        parseError: error instanceof Error ? error.message : String(error),
      })
      return null
    }
    const parsed = PluginManifestSchema().safeParse(rawJson)
    if (!parsed.success) {
      params.errors.push({
        type: 'manifest-validation-error',
        source: params.sourceId,
        manifestPath,
        validationErrors: [parsed.error.message],
      })
      return null
    }
    manifest = {
      ...(params.fallbackManifest ?? {}),
      ...parsed.data,
    } as PluginManifest
  } else if (params.fallbackManifest?.name) {
    manifest = params.fallbackManifest as PluginManifest
  } else {
    params.errors.push({
      type: 'manifest-parse-error',
      source: params.sourceId,
      manifestPath: join(root, '.copilot-plugin', 'plugin.json'),
      parseError: 'Missing plugin.json manifest',
    })
    return null
  }

  const commandsPaths =
    typeof manifest.commands === 'string' || Array.isArray(manifest.commands)
      ? toPathArray(root, manifest.commands, 'commands')
      : toPathArray(root, undefined, 'commands')

  const commandsMetadata =
    manifest.commands &&
    typeof manifest.commands === 'object' &&
    !Array.isArray(manifest.commands)
      ? manifest.commands
      : undefined

  const skillsPaths = toPathArray(root, manifest.skills, 'skills')
  const agentsPaths = toPathArray(root, manifest.agents, 'agents')
  const outputStylesPaths = toPathArray(
    root,
    manifest.outputStyles,
    'output-styles',
  )
  const hooksConfig = loadHooksConfigFromPlugin(
    root,
    manifest,
    manifest.name,
    params.errors,
  )

  let pluginSettings: Record<string, unknown> | undefined = manifest.settings
  const settingsFilePath = join(root, 'settings.json')
  if (existsSync(settingsFilePath)) {
    try {
      const diskSettings = JSON.parse(
        readFileSync(settingsFilePath, 'utf8'),
      ) as Record<string, unknown>
      // Only safe `agent` default keys are merged into pluginSettingsBase
      if (typeof diskSettings.agent === 'string') {
        pluginSettings = { ...(pluginSettings ?? {}), agent: diskSettings.agent }
      }
    } catch {
      // Ignore invalid plugin settings.json
    }
  }

  return {
    name: manifest.name,
    manifest,
    path: root,
    source: params.sourceId,
    repository: params.repository,
    enabled: params.enabled,
    ...(commandsPaths[0] ? { commandsPath: commandsPaths[0], commandsPaths } : {}),
    ...(commandsMetadata ? { commandsMetadata } : {}),
    ...(skillsPaths[0] ? { skillsPath: skillsPaths[0], skillsPaths } : {}),
    ...(agentsPaths[0] ? { agentsPath: agentsPaths[0], agentsPaths } : {}),
    ...(outputStylesPaths[0]
      ? { outputStylesPath: outputStylesPaths[0], outputStylesPaths }
      : {}),
    ...(hooksConfig ? { hooksConfig } : {}),
    ...(pluginSettings ? { settings: pluginSettings } : {}),
  }
}

function applyMergedPluginBaseSettings(enabledPlugins: readonly LoadedPlugin[]): void {
  const mergedBase: Record<string, unknown> = {}
  for (const plugin of enabledPlugins) {
    if (plugin.settings && typeof plugin.settings.agent === 'string') {
      mergedBase.agent = plugin.settings.agent
    }
  }
  setPluginSettingsBase(
    Object.keys(mergedBase).length > 0 ? mergedBase : undefined,
  )
}

function loadPluginsInternal(allowAutoCache: boolean): Promise<PluginLoadResult> {
  return (async (): Promise<PluginLoadResult> => {
    const enabled: LoadedPlugin[] = []
    const disabled: LoadedPlugin[] = []
    const errors: PluginError[] = []
    const seenIds = new Set<string>()
    const cwd = getCwd()

    const inlineDirs = getInlinePlugins()
    if (isBareMode() && inlineDirs.length === 0) {
      return { enabled: [], disabled: [], errors: [] }
    }

    const managedNames = getManagedPluginNames()

    // 1. Session `--plugin-dir` (`@inline`) plugins (cannot override policy-locked names)
    for (const rawDir of inlineDirs) {
      const absDir = resolve(cwd, rawDir)
      const tempErrors: PluginError[] = []
      const loaded = createPluginFromPath({
        pluginPath: absDir,
        sourceId: `inline:${absDir}`,
        repository: 'inline',
        enabled: true,
        errors: tempErrors,
      })
      errors.push(...tempErrors)
      if (!loaded) continue
      if (managedNames.has(loaded.name)) {
        errors.push({
          type: 'generic-error',
          source: `${loaded.name}@inline`,
          plugin: loaded.name,
          error: `Inline --plugin-dir "${loaded.name}" cannot override managed policy plugin.`,
        })
        continue
      }
      const inlineId = `${loaded.name}@inline`
      loaded.source = inlineId
      seenIds.add(inlineId)
      enabled.push(loaded)
    }

    if (!isBareMode()) {
      const settings = getInitialSettings()
      const enabledMap = settings.enabledPlugins ?? {}
      const installedMap = getInstalledPluginsV2().plugins

      const allKnownIds = new Set<string>([
        ...Object.keys(enabledMap),
        ...Object.keys(installedMap),
      ])

      // 2. Marketplace / installed plugins
      for (const pluginId of allKnownIds) {
        if (seenIds.has(pluginId)) continue
        seenIds.add(pluginId)

        const policyBlocked = isPluginBlockedByPolicy(pluginId)
        const settingVal = enabledMap[pluginId]
        const isEnabledIntent =
          !policyBlocked &&
          (settingVal === true || Array.isArray(settingVal))

        let installEntry = resolveInstalledPluginEntry(pluginId, cwd)
        if (!installEntry && isEnabledIntent && allowAutoCache) {
          const parsed = parsePluginIdentifier(pluginId)
          if (parsed.marketplace) {
            const mp = loadMarketplaceManifest(parsed.marketplace)
            const mpEntry = mp?.plugins.find(p => p.name === parsed.name)
            if (mpEntry) {
              try {
                const cached = await cacheMarketplacePlugin(
                  parsed.marketplace,
                  mpEntry,
                )
                const freshEntry = {
                  scope: 'user' as const,
                  installPath: cached.installPath,
                  version: cached.version,
                  installedAt: new Date().toISOString(),
                }
                recordInstalledPlugin(pluginId, freshEntry)
                installEntry = freshEntry
              } catch (error) {
                errors.push({
                  type: 'generic-error',
                  source: pluginId,
                  plugin: parsed.name,
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
          }
        }

        if (!installEntry) {
          if (isEnabledIntent) {
            const parsed = parsePluginIdentifier(pluginId)
            errors.push({
              type: 'plugin-not-found',
              source: pluginId,
              pluginId: parsed.name,
              marketplace: parsed.marketplace ?? 'unknown',
            })
          }
          continue
        }

        if (!existsSync(installEntry.installPath)) {
          if (isEnabledIntent) {
            errors.push({
              type: 'plugin-cache-miss',
              source: pluginId,
              plugin: parsePluginIdentifier(pluginId).name,
              installPath: installEntry.installPath,
            })
          }
          continue
        }

        const parsedId = parsePluginIdentifier(pluginId)
        const loaded = createPluginFromPath({
          pluginPath: installEntry.installPath,
          sourceId: pluginId,
          repository: parsedId.marketplace ?? 'local',
          enabled: isEnabledIntent,
          errors,
        })
        if (!loaded) continue

        if (isEnabledIntent) {
          enabled.push(loaded)
        } else {
          disabled.push(loaded)
        }
      }

      // 3. Built-in (`@builtin`) plugins
      for (const builtin of getBuiltinPlugins()) {
        const builtinId = `${builtin.name}@builtin`
        if (seenIds.has(builtinId)) continue
        seenIds.add(builtinId)

        const settingVal = settings.enabledPlugins?.[builtinId]
        const isEnabled =
          !isPluginBlockedByPolicy(builtinId) &&
          (settingVal !== undefined
            ? Boolean(settingVal)
            : (builtin.defaultEnabled ?? true))

        const pluginObj: LoadedPlugin = {
          name: builtin.name,
          manifest: {
            name: builtin.name,
            version: builtin.version,
            description: builtin.description,
          },
          path: '',
          source: builtinId,
          repository: 'builtin',
          enabled: isEnabled,
          isBuiltin: true,
          hooksConfig: builtin.hooks,
          mcpServers: builtin.mcpServers,
        }
        if (isEnabled) {
          enabled.push(pluginObj)
        } else {
          disabled.push(pluginObj)
        }
      }
    }

    const verified = verifyAndDemote(enabled, disabled, errors)
    applyMergedPluginBaseSettings(verified.enabled)

    const finalResult: PluginLoadResult = {
      enabled: verified.enabled,
      disabled: verified.disabled,
      errors,
    }
    cachedLoadResult = finalResult
    return finalResult
  })()
}

/**
 * Loads all plugins, materializing any enabled but uncached marketplace plugins.
 */
export async function loadAllPlugins(): Promise<PluginLoadResult> {
  if (cachedLoadResult) {
    return cachedLoadResult
  }
  return loadPluginsInternal(true)
}

/**
 * Non-blocking startup fast path reading cached `installed_plugins.json` paths
 * directly without performing network/git fetches.
 */
export async function loadAllPluginsCacheOnly(): Promise<PluginLoadResult> {
  if (cachedLoadResult) {
    return cachedLoadResult
  }
  return loadPluginsInternal(false)
}
