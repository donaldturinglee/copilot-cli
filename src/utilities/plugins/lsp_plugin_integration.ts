/**
 * Component Loader #7: Loads LSP server configurations (`.lsp.json` and
 * `manifest.lspServers`) from enabled plugins with variable substitution and
 * `plugin:<pluginName>:<serverName>` scoping.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ConfigScope, LspServerConfig } from '../../types/forward.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { expandEnvVarsInString } from '../../services/mcp/env_expansion.js'
import { getPluginDataDir, resolvePathWithinPlugin } from './plugin_directories.js'
import { loadAllPluginsCacheOnly } from './plugin_loader.js'
import {
  loadPluginOptions,
  substitutePluginRootAndData,
  substituteUserConfigVariables,
} from './plugin_options_storage.js'
import { LspServerConfigSchema, type PluginUserConfigOption } from './schemas.js'

export type ScopedLspServerConfig = LspServerConfig & {
  scope: ConfigScope
  source: string
}

function resolvePluginLspVariables(
  config: LspServerConfig,
  plugin: LoadedPlugin,
): LspServerConfig {
  const userOptions = loadPluginOptions(plugin.source)
  const schema = plugin.manifest.userConfig as
    | Record<string, PluginUserConfigOption>
    | undefined

  const sub = (val: string) =>
    expandEnvVarsInString(
      substituteUserConfigVariables(
        substitutePluginRootAndData(val, plugin.path, plugin.source),
        userOptions,
        schema,
      ),
    ).expanded

  const envOut: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: plugin.path,
    COPILOT_PLUGIN_ROOT: plugin.path,
    CLAUDE_PLUGIN_DATA: getPluginDataDir(plugin.source, true),
    COPILOT_PLUGIN_DATA: getPluginDataDir(plugin.source, true),
  }
  for (const [k, v] of Object.entries(config.env ?? {})) {
    envOut[k] = sub(v)
  }

  return {
    ...config,
    command: sub(config.command),
    ...(config.args ? { args: config.args.map(sub) } : {}),
    ...(config.workspaceFolder
      ? { workspaceFolder: sub(config.workspaceFolder) }
      : {}),
    env: envOut,
  }
}

/**
 * Loads validated `ScopedLspServerConfig` entries for a single `LoadedPlugin`.
 */
export function loadPluginLspServersForSinglePlugin(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Record<string, ScopedLspServerConfig> {
  if (plugin.isBuiltin || !plugin.path) {
    return {}
  }

  const rawServers: Record<string, LspServerConfig> = {}
  const ingestMap = (map: Record<string, unknown>, label: string) => {
    for (const [srvName, rawCfg] of Object.entries(map)) {
      const parsed = LspServerConfigSchema().safeParse(rawCfg)
      if (!parsed.success) {
        errors.push({
          type: 'lsp-config-invalid',
          source: plugin.source,
          plugin: plugin.name,
          serverName: srvName || label,
          validationError: parsed.error.message,
        })
        continue
      }
      rawServers[srvName] = parsed.data
    }
  }

  const dotLspPath = join(plugin.path, '.lsp.json')
  if (existsSync(dotLspPath)) {
    try {
      const rawJson = JSON.parse(readFileSync(dotLspPath, 'utf8')) as Record<
        string,
        unknown
      >
      const map =
        rawJson &&
        typeof rawJson === 'object' &&
        'lspServers' in rawJson &&
        rawJson.lspServers &&
        typeof rawJson.lspServers === 'object'
          ? (rawJson.lspServers as Record<string, unknown>)
          : rawJson
      ingestMap(map, '.lsp.json')
    } catch (error) {
      errors.push({
        type: 'lsp-config-invalid',
        source: plugin.source,
        plugin: plugin.name,
        serverName: '.lsp.json',
        validationError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const manifestSpecs = plugin.manifest.lspServers
    ? Array.isArray(plugin.manifest.lspServers)
      ? plugin.manifest.lspServers
      : [plugin.manifest.lspServers]
    : []

  for (const spec of manifestSpecs) {
    if (typeof spec === 'string') {
      const jsonPath = resolvePathWithinPlugin(plugin.path, spec)
      if (!jsonPath || !existsSync(jsonPath)) {
        errors.push({
          type: 'lsp-config-invalid',
          source: plugin.source,
          plugin: plugin.name,
          serverName: spec,
          validationError: 'LSP config JSON path not found or outside plugin root',
        })
        continue
      }
      try {
        const rawJson = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<
          string,
          unknown
        >
        ingestMap(rawJson, spec)
      } catch (error) {
        errors.push({
          type: 'lsp-config-invalid',
          source: plugin.source,
          plugin: plugin.name,
          serverName: spec,
          validationError:
            error instanceof Error ? error.message : String(error),
        })
      }
    } else if (spec && typeof spec === 'object') {
      ingestMap(spec as Record<string, unknown>, 'manifest.lspServers')
    }
  }

  const scoped: Record<string, ScopedLspServerConfig> = {}
  for (const [srvName, cfg] of Object.entries(rawServers)) {
    const resolved = resolvePluginLspVariables(cfg, plugin)
    scoped[`plugin:${plugin.name}:${srvName}`] = {
      ...resolved,
      scope: 'dynamic',
      source: plugin.name,
    }
  }
  return scoped
}

/**
 * Loads all LSP servers across enabled plugins.
 */
export async function getAllPluginLspServers(
  pluginsOverride?: readonly LoadedPlugin[],
): Promise<{
  servers: Record<string, ScopedLspServerConfig>
  errors: PluginError[]
}> {
  const enabled = pluginsOverride ?? (await loadAllPluginsCacheOnly()).enabled
  const servers: Record<string, ScopedLspServerConfig> = {}
  const errors: PluginError[] = []

  for (const plugin of enabled) {
    Object.assign(
      servers,
      loadPluginLspServersForSinglePlugin(plugin, errors),
    )
  }
  return { servers, errors }
}
