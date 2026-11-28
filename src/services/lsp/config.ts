/**
 * Aggregates configured LSP servers from enabled plugins (`.lsp.json` and
 * `manifest.lspServers`) plus optional workspace `.lsp.json`.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from '../../utilities/cwd.js'
import { getAllPluginLspServers } from '../../utilities/plugins/lsp_plugin_integration.js'
import { LspServerConfigSchema } from '../../utilities/plugins/schemas.js'
import type { ScopedLspServerConfig } from './types.js'

/**
 * Loads all active LSP server configurations without throwing outward.
 */
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const allServers: Record<string, ScopedLspServerConfig> = {}

  try {
    const pluginRes = await getAllPluginLspServers()
    Object.assign(allServers, pluginRes.servers)
  } catch {
    // Isolate plugin load failures
  }

  // Also check workspace `.lsp.json` when present
  const workspaceLspPath = join(getCwd(), '.lsp.json')
  if (existsSync(workspaceLspPath)) {
    try {
      const rawJson = JSON.parse(readFileSync(workspaceLspPath, 'utf8')) as Record<
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
      for (const [name, cfg] of Object.entries(map)) {
        const parsed = LspServerConfigSchema().safeParse(cfg)
        if (parsed.success) {
          allServers[name] = {
            ...parsed.data,
            scope: 'project',
            source: '.lsp.json',
          }
        }
      }
    } catch {
      // Ignore malformed workspace .lsp.json
    }
  }

  return { servers: allServers }
}
