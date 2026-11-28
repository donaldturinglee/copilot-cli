/**
 * Hot-reload orchestrator (`clearAllPluginCaches` + `refreshActivePlugins`)
 * powering `/reload-plugins` and post-install state synchronization.
 */

import { clearCommandsCache } from '../../commands.js'
import type { AppState } from '../../state/app_state_store.js'
import type { Command } from '../../types/command.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { refreshInstalledPluginsSnapshot } from './installed_plugins_manager.js'
import {
  clearPluginAgentCache,
  loadPluginAgents,
} from './load_plugin_agents.js'
import {
  clearPluginCommandCache,
  getPluginCommands,
} from './load_plugin_commands.js'
import { loadPluginHooks } from './load_plugin_hooks.js'
import {
  clearPluginOutputStylesCache,
  loadPluginOutputStyles,
} from './load_plugin_output_styles.js'
import { getAllPluginLspServers } from './lsp_plugin_integration.js'
import { clearMarketplaceCache } from './marketplace_manager.js'
import { loadPluginMcpServers } from './mcp_plugin_integration.js'
import { clearPluginCache, loadAllPlugins } from './plugin_loader.js'

let lspReinitializer: (() => Promise<void>) | null = null

/**
 * Registers the Step 8.4 LSP manager re-initializer so `/reload-plugins` reloads
 * `.lsp.json` servers without circular module dependencies.
 */
export function registerPluginLspReinitializer(
  fn: (() => Promise<void>) | null,
): void {
  lspReinitializer = fn
}

/**
 * Clears all memoized plugin, marketplace, command, agent, and output-style caches.
 */
export function clearAllPluginCaches(): void {
  refreshInstalledPluginsSnapshot()
  clearMarketplaceCache()
  clearPluginCache()
  clearPluginCommandCache()
  clearPluginAgentCache()
  clearPluginOutputStylesCache()
  clearCommandsCache()
}

export interface RefreshPluginsSummary {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  commands: Command[]
  agentCount: number
  hookMatcherCount: number
  mcpServerCount: number
  lspServerCount: number
  errors: PluginError[]
}

/**
 * Reloads all plugins, commands, skills, agents, hooks, output styles, MCP
 * servers, and LSP servers, updating `AppState` and bumping
 * `mcp.pluginReconnectKey` to reconnect dynamic plugin MCP clients.
 */
export async function refreshActivePlugins(
  setAppState?: (updater: (prev: AppState) => AppState) => void,
): Promise<RefreshPluginsSummary> {
  clearAllPluginCaches()

  const loaded = await loadAllPlugins()
  const [commands, agents, hookMatcherCount, mcpRes, lspRes] = await Promise.all([
    getPluginCommands(loaded.enabled),
    loadPluginAgents(loaded.enabled),
    loadPluginHooks(loaded.enabled),
    loadPluginMcpServers(loaded.enabled),
    getAllPluginLspServers(loaded.enabled),
  ])
  await loadPluginOutputStyles(loaded.enabled)

  if (lspReinitializer) {
    await lspReinitializer().catch(() => {})
  }

  const allErrors: PluginError[] = [
    ...loaded.errors,
    ...mcpRes.errors,
    ...lspRes.errors,
  ]

  setAppState?.(prev => ({
    ...prev,
    plugins: {
      ...prev.plugins,
      enabled: loaded.enabled,
      disabled: loaded.disabled,
      commands,
      errors: allErrors,
      needsRefresh: false,
    },
    agentDefinitions: {
      ...prev.agentDefinitions,
      activeAgents: agents,
      allAgents: agents,
    },
    mcp: {
      ...prev.mcp,
      pluginReconnectKey: prev.mcp.pluginReconnectKey + 1,
    },
  }))

  return {
    enabled: loaded.enabled,
    disabled: loaded.disabled,
    commands,
    agentCount: agents.length,
    hookMatcherCount,
    mcpServerCount: Object.keys(mcpRes.servers).length,
    lspServerCount: Object.keys(lspRes.servers).length,
    errors: allErrors,
  }
}
