/**
 * Reads `claude_desktop_config.json` from macOS, Windows, Linux, or WSL paths
 * for `copilot mcp add-from-claude-desktop`.
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  McpServerConfigSchema,
  type McpServerConfig,
} from '../services/mcp/types.js'

/**
 * Resolves candidate `claude_desktop_config.json` paths for the host OS.
 */
export function getClaudeDesktopConfigPaths(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [
      join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
    ]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(appData, 'Claude', 'claude_desktop_config.json')]
  }
  return [
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  ]
}

/**
 * Reads validated `mcpServers` entries from Claude Desktop if installed.
 */
export function readClaudeDesktopMcpServers(customPath?: string): {
  path: string | null
  servers: Record<string, McpServerConfig>
} {
  const candidates = customPath ? [customPath] : getClaudeDesktopConfigPaths()
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        mcpServers?: Record<string, unknown>
      }
      const servers: Record<string, McpServerConfig> = {}
      for (const [name, rawCfg] of Object.entries(parsed.mcpServers ?? {})) {
        const res = McpServerConfigSchema().safeParse(rawCfg)
        if (res.success) {
          servers[name] = res.data
        }
      }
      return { path: candidate, servers }
    } catch {
      return { path: candidate, servers: {} }
    }
  }
  return { path: null, servers: {} }
}
