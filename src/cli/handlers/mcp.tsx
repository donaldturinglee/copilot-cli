/**
 * CLI handlers for `copilot mcp {serve,add,remove,list,get,add-json,add-from-claude-desktop,reset-project-choices}`.
 */

import pMap from 'p-map'
import { executeMcpAddCommand, type McpAddCliOptions } from '../../commands/mcp/add_command.js'
import { FIGURES } from '../../constants/figures.js'
import { startMcpServer } from '../../entrypoints/mcp.js'
import {
  clearMcpClientConfig,
  revokeServerTokens,
  saveMcpClientSecret,
  type OauthCapableMcpConfig,
} from '../../services/mcp/auth.js'
import { fetchClaudeAiMcpConfigs } from '../../services/mcp/claudeai.js'
import { cleanupAllMcpClients, connectToServer } from '../../services/mcp/client.js'
import {
  addMcpConfig,
  describeMcpConfigFilePath,
  getClaudeCodeMcpConfigs,
  getMcpConfigByName,
  removeMcpConfig,
} from '../../services/mcp/config.js'
import { McpServerConfigSchema } from '../../services/mcp/types.js'
import { readClaudeDesktopMcpServers } from '../../utilities/claude_desktop.js'
import { saveCurrentProjectConfig } from '../../utilities/config.js'
import { getCwd } from '../../utilities/cwd.js'

/**
 * Handles `copilot mcp serve`.
 */
export async function mcpServeHandler(options?: {
  debug?: boolean
  verbose?: boolean
}): Promise<void> {
  await startMcpServer(getCwd(), options?.debug, options?.verbose)
}

/**
 * Handles `copilot mcp add <name> <commandOrUrl> [args...]`.
 */
export async function mcpAddHandler(
  name: string,
  commandOrUrl: string,
  args: string[] = [],
  options: McpAddCliOptions = {},
): Promise<void> {
  const { scope, config } = executeMcpAddCommand(
    name,
    commandOrUrl,
    args,
    options,
  )
  const kind = config.type ?? 'stdio'
  process.stdout.write(
    `Added ${kind} MCP server "${name}" to ${scope} config (${describeMcpConfigFilePath(scope)}).\n`,
  )
}

/**
 * Handles `copilot mcp add-json <name> <json>`.
 */
export async function mcpAddJsonHandler(
  name: string,
  rawJson: string,
  options?: { scope?: string; clientSecret?: string },
): Promise<void> {
  const scopeRaw = (options?.scope ?? 'local').toLowerCase()
  if (scopeRaw !== 'local' && scopeRaw !== 'user' && scopeRaw !== 'project') {
    throw new Error(`Invalid --scope "${options?.scope}".`)
  }
  const parsedJson: unknown = JSON.parse(rawJson)
  const config = McpServerConfigSchema().parse(parsedJson)
  addMcpConfig(name, config, scopeRaw)
  if (options?.clientSecret && (config.type === 'http' || config.type === 'sse')) {
    saveMcpClientSecret(
      name,
      config,
      options.clientSecret,
      config.oauth?.clientId,
    )
  }
  process.stdout.write(
    `Added MCP server "${name}" from JSON to ${scopeRaw} config.\n`,
  )
}

/**
 * Handles `copilot mcp remove <name>`.
 */
export async function mcpRemoveHandler(
  name: string,
  options?: { scope?: string },
): Promise<void> {
  const scopeRaw = options?.scope?.toLowerCase() as
    | 'local'
    | 'user'
    | 'project'
    | undefined
  const existing = getMcpConfigByName(name)
  const res = removeMcpConfig(name, scopeRaw)
  if (!res.removed) {
    throw new Error(`MCP server "${name}" not found.`)
  }
  if (existing && (existing.type === 'http' || existing.type === 'sse')) {
    await revokeServerTokens(name, existing as OauthCapableMcpConfig).catch(
      () => {},
    )
    clearMcpClientConfig(name, existing)
  }
  process.stdout.write(
    `Removed MCP server "${name}" from ${res.scope} config.\n`,
  )
}

/**
 * Handles `copilot mcp list` with concurrent health probes.
 */
export async function mcpListHandler(): Promise<void> {
  const base = getClaudeCodeMcpConfigs()
  const claudeAi = await fetchClaudeAiMcpConfigs()
  const servers = { ...claudeAi, ...base.servers }
  const entries = Object.entries(servers)

  if (entries.length === 0) {
    process.stdout.write(
      'No MCP servers configured. Use `copilot mcp add` to add a server.\n',
    )
    return
  }

  process.stdout.write('Checking MCP server health...\n\n')
  try {
    const lines = await pMap(
      entries,
      async ([name, cfg]) => {
        const conn = await connectToServer(name, cfg)
        const endpoint =
          !cfg.type || cfg.type === 'stdio'
            ? `${cfg.command} ${(cfg.args ?? []).join(' ')}`.trim()
            : 'url' in cfg
              ? cfg.url
              : cfg.type
        if (conn.type === 'connected') {
          return `${name}: ${endpoint} - ${FIGURES.tick} Connected`
        }
        if (conn.type === 'needs-auth') {
          return `${name}: ${endpoint} - ! Needs authentication`
        }
        if (conn.type === 'disabled') {
          return `${name}: ${endpoint} - ○ Disabled`
        }
        return `${name}: ${endpoint} - ${FIGURES.cross} Failed to connect${conn.type === 'failed' && conn.error ? ` (${conn.error})` : ''}`
      },
      { concurrency: 5 },
    )
    process.stdout.write(`${lines.join('\n')}\n`)
  } finally {
    await cleanupAllMcpClients()
  }
}

/**
 * Handles `copilot mcp get <name>`.
 */
export async function mcpGetHandler(name: string): Promise<void> {
  const cfg = getMcpConfigByName(name)
  if (!cfg) {
    throw new Error(`No MCP server found with name "${name}".`)
  }
  try {
    const conn = await connectToServer(name, cfg)
    const statusText =
      conn.type === 'connected'
        ? `${FIGURES.tick} Connected`
        : conn.type === 'needs-auth'
          ? '! Needs authentication'
          : `${FIGURES.cross} ${conn.type}`
    const lines = [
      `${name}:`,
      `  Scope: ${cfg.scope} (${describeMcpConfigFilePath(cfg.scope)})`,
      `  Status: ${statusText}`,
      `  Type: ${cfg.type ?? 'stdio'}`,
    ]
    if (!cfg.type || cfg.type === 'stdio') {
      lines.push(`  Command: ${cfg.command}`)
      if (cfg.args?.length) {
        lines.push(`  Args: ${cfg.args.join(' ')}`)
      }
    } else if ('url' in cfg) {
      lines.push(`  URL: ${cfg.url}`)
    }
    lines.push(
      `\nTo remove this server, run: copilot mcp remove "${name}" -s ${cfg.scope}`,
    )
    process.stdout.write(`${lines.join('\n')}\n`)
  } finally {
    await cleanupAllMcpClients()
  }
}

/**
 * Handles `copilot mcp add-from-claude-desktop`.
 */
export async function mcpAddFromDesktopHandler(options?: {
  scope?: string
  configPath?: string
}): Promise<void> {
  const scopeRaw = (options?.scope ?? 'local').toLowerCase()
  if (scopeRaw !== 'local' && scopeRaw !== 'user' && scopeRaw !== 'project') {
    throw new Error(`Invalid --scope "${options?.scope}".`)
  }
  const { path, servers } = readClaudeDesktopMcpServers(options?.configPath)
  const entries = Object.entries(servers)
  if (!path || entries.length === 0) {
    process.stdout.write(
      'No MCP servers found in Claude Desktop configuration.\n',
    )
    return
  }
  for (const [name, cfg] of entries) {
    addMcpConfig(name, cfg, scopeRaw)
  }
  process.stdout.write(
    `Imported ${entries.length} MCP server(s) from ${path} into ${scopeRaw} scope.\n`,
  )
}

/**
 * Handles `copilot mcp reset-project-choices`.
 */
export async function mcpResetProjectChoicesHandler(): Promise<void> {
  saveCurrentProjectConfig(prev => ({
    ...prev,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
  }))
  process.stdout.write(
    'All project-scoped (.mcp.json) server approvals and rejections have been reset.\n',
  )
}
