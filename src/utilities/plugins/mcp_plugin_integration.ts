/**
 * Component Loader #6: Loads MCP servers (`.mcp.json`, inline `manifest.mcpServers`,
 * and `.mcpb`/`.dxt` bundles) from enabled plugins, substituting
 * `${COPILOT_PLUGIN_ROOT}`, `${COPILOT_PLUGIN_DATA}`, `${user_config.KEY}`, and
 * `${ENV_VAR}` and scoping server names as `plugin:<pluginName>:<serverName>`.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { registerPluginMcpServersProvider } from '../../services/mcp/config.js'
import { expandEnvVarsInConfig } from '../../services/mcp/env_expansion.js'
import {
  McpServerConfigSchema,
  type McpServerConfig,
  type ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { isMcpbSource, loadMcpbServer } from './mcpb_handler.js'
import { getPluginDataDir, resolvePathWithinPlugin } from './plugin_directories.js'
import { loadAllPluginsCacheOnly } from './plugin_loader.js'
import {
  loadPluginOptions,
  substitutePluginRootAndData,
  substituteUserConfigVariables,
  type PluginOptionValues,
} from './plugin_options_storage.js'
import type { PluginUserConfigOption } from './schemas.js'

function substituteMcpConfigVars(
  config: McpServerConfig,
  plugin: LoadedPlugin,
  userOptions: PluginOptionValues,
  schema?: Record<string, PluginUserConfigOption>,
): McpServerConfig {
  const sub = (val: string) =>
    substituteUserConfigVariables(
      substitutePluginRootAndData(val, plugin.path, plugin.source),
      userOptions,
      schema,
    )

  let resolved: McpServerConfig
  if (!config.type || config.type === 'stdio') {
    const envOut: Record<string, string> = {
      CLAUDE_PLUGIN_ROOT: plugin.path,
      COPILOT_PLUGIN_ROOT: plugin.path,
      CLAUDE_PLUGIN_DATA: getPluginDataDir(plugin.source, true),
      COPILOT_PLUGIN_DATA: getPluginDataDir(plugin.source, true),
    }
    for (const [k, v] of Object.entries(config.env ?? {})) {
      envOut[k] = sub(v)
    }
    resolved = {
      ...config,
      command: sub(config.command),
      ...(config.args ? { args: config.args.map(sub) } : {}),
      env: envOut,
    }
  } else if (
    config.type === 'sse' ||
    config.type === 'http' ||
    config.type === 'ws'
  ) {
    const headersOut: Record<string, string> | undefined = config.headers
      ? Object.fromEntries(
          Object.entries(config.headers).map(([k, v]) => [k, sub(v)]),
        )
      : undefined
    resolved = {
      ...config,
      url: sub(config.url),
      ...(headersOut ? { headers: headersOut } : {}),
    }
  } else {
    resolved = config
  }

  return expandEnvVarsInConfig(resolved).expanded
}

/**
 * Loads `ScopedMcpServerConfig` entries for a single `LoadedPlugin`.
 */
export async function loadPluginMcpServersForSinglePlugin(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, ScopedMcpServerConfig>> {
  const rawMap: Record<string, McpServerConfig> = {}
  const userOptions = loadPluginOptions(plugin.source)
  const baseSchema = (plugin.manifest.userConfig ?? {}) as Record<
    string,
    PluginUserConfigOption
  >

  const ingestRecord = (rec: Record<string, unknown>) => {
    for (const [srvName, rawCfg] of Object.entries(rec)) {
      const parsed = McpServerConfigSchema().safeParse(rawCfg)
      if (!parsed.success) {
        errors.push({
          type: 'mcp-config-invalid',
          source: plugin.source,
          plugin: plugin.name,
          serverName: srvName,
          validationError: parsed.error.message,
        })
        continue
      }
      rawMap[srvName] = parsed.data
    }
  }

  if (plugin.isBuiltin && plugin.mcpServers) {
    ingestRecord(plugin.mcpServers)
  }

  if (!plugin.isBuiltin && plugin.path) {
    const dotMcpPath = join(plugin.path, '.mcp.json')
    if (existsSync(dotMcpPath)) {
      try {
        const parsedJson = JSON.parse(readFileSync(dotMcpPath, 'utf8')) as {
          mcpServers?: Record<string, unknown>
        }
        ingestRecord(
          parsedJson &&
            typeof parsedJson === 'object' &&
            'mcpServers' in parsedJson
            ? (parsedJson.mcpServers ?? {})
            : (parsedJson as Record<string, unknown>),
        )
      } catch (error) {
        errors.push({
          type: 'mcp-config-invalid',
          source: plugin.source,
          plugin: plugin.name,
          serverName: '.mcp.json',
          validationError:
            error instanceof Error ? error.message : String(error),
        })
      }
    }

    const specs = plugin.manifest.mcpServers
      ? Array.isArray(plugin.manifest.mcpServers)
        ? plugin.manifest.mcpServers
        : [plugin.manifest.mcpServers]
      : []

    for (const spec of specs) {
      if (typeof spec === 'string') {
        if (isMcpbSource(spec)) {
          try {
            const mcpbRes = await loadMcpbServer({
              source: spec,
              pluginPath: plugin.path,
              pluginId: plugin.source,
            })
            if (mcpbRes.status === 'loaded') {
              rawMap[mcpbRes.serverName] = mcpbRes.config
            }
          } catch (error) {
            errors.push({
              type: 'mcpb-extract-failed',
              source: plugin.source,
              plugin: plugin.name,
              mcpbPath: spec,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
          continue
        }

        const jsonPath = resolvePathWithinPlugin(plugin.path, spec)
        if (!jsonPath || !existsSync(jsonPath)) {
          errors.push({
            type: 'mcp-config-invalid',
            source: plugin.source,
            plugin: plugin.name,
            serverName: spec,
            validationError: 'MCP config JSON path not found or outside plugin root',
          })
          continue
        }
        try {
          const parsedJson = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
            mcpServers?: Record<string, unknown>
          }
          ingestRecord(
            parsedJson &&
              typeof parsedJson === 'object' &&
              'mcpServers' in parsedJson
              ? (parsedJson.mcpServers ?? {})
              : (parsedJson as Record<string, unknown>),
          )
        } catch (error) {
          errors.push({
            type: 'mcp-config-invalid',
            source: plugin.source,
            plugin: plugin.name,
            serverName: spec,
            validationError:
              error instanceof Error ? error.message : String(error),
          })
        }
      } else if (spec && typeof spec === 'object') {
        ingestRecord(spec as Record<string, unknown>)
      }
    }
  }

  const scoped: Record<string, ScopedMcpServerConfig> = {}
  for (const [srvName, cfg] of Object.entries(rawMap)) {
    const resolved = plugin.isBuiltin
      ? cfg
      : substituteMcpConfigVars(cfg, plugin, userOptions, baseSchema)
    const scopedKey = `plugin:${plugin.name}:${srvName}`
    scoped[scopedKey] = {
      ...resolved,
      scope: 'dynamic',
      pluginSource: plugin.source,
    }
  }
  return scoped
}

/**
 * Loads all MCP servers across currently enabled plugins.
 */
export async function loadPluginMcpServers(
  pluginsOverride?: readonly LoadedPlugin[],
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  const enabled = pluginsOverride ?? (await loadAllPluginsCacheOnly()).enabled
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const errors: PluginError[] = []

  for (const plugin of enabled) {
    const pluginServers = await loadPluginMcpServersForSinglePlugin(
      plugin,
      errors,
    )
    Object.assign(servers, pluginServers)
  }

  return { servers, errors }
}

registerPluginMcpServersProvider(async () => {
  const res = await loadPluginMcpServers()
  return {
    servers: res.servers,
    errors: res.errors.map(e => e.type),
  }
})
